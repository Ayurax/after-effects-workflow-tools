// ============================================================================
// ANCHOR PRESET HELPER
// ============================================================================
function setAnchorPreset(layer, presetName) {
    if (!layer.sourceRectAtTime) return false;

    var comp = app.project.activeItem;
    var currentTime = comp.time;
    var sourceRect = layer.sourceRectAtTime(currentTime, false);

    var left = sourceRect[0], top = sourceRect[1], width = sourceRect[2], height = sourceRect[3];
    var anchorX, anchorY;

    switch (presetName) {
        case "TL": anchorX = left; anchorY = top; break;
        case "TC": anchorX = left + width / 2; anchorY = top; break;
        case "TR": anchorX = left + width; anchorY = top; break;
        case "CL": anchorX = left; anchorY = top + height / 2; break;
        case "C": anchorX = left + width / 2; anchorY = top + height / 2; break;
        case "CR": anchorX = left + width; anchorY = top + height / 2; break;
        case "BL": anchorX = left; anchorY = top + height; break;
        case "BC": anchorX = left + width / 2; anchorY = top + height; break;
        case "BR": anchorX = left + width; anchorY = top + height; break;
        default: return false;
    }

    try {
        var currentAnchor = layer.anchorPoint.value;
        var currentPosition = layer.position.value;
        var is3D = layer.threeDLayer;

        var offsetX = anchorX - currentAnchor[0];
        var offsetY = anchorY - currentAnchor[1];

        var newAnchor = is3D ? [anchorX, anchorY, currentAnchor[2]] : [anchorX, anchorY];
        var newPosition = is3D
            ? [currentPosition[0] + offsetX, currentPosition[1] + offsetY, currentPosition[2]]
            : [currentPosition[0] + offsetX, currentPosition[1] + offsetY];

        var anchorProp = layer.anchorPoint;
        var posProp = layer.position;

        if (posProp.numKeys > 0) {
            posProp.setValueAtTime(currentTime, newPosition);
        } else {
            posProp.setValue(newPosition);
        }

        if (anchorProp.numKeys > 0) {
            anchorProp.setValueAtTime(currentTime, newAnchor);
        } else {
            anchorProp.setValue(newAnchor);
        }

        return true;
    } catch (e) {
        return false;
    }
}


// ============================================================================
// ANCHOR PRESET POPUP
// ============================================================================
function openAnchorPresetPanel() {
    var comp = app.project.activeItem;
    if (!comp || !(comp instanceof CompItem)) {
        alert("Select a composition");
        return;
    }

    var selectedLayers = comp.selectedLayers;
    if (selectedLayers.length === 0) {
        alert("Select at least one layer");
        return;
    }

    var win = new Window("palette", "Anchor Presets", undefined, {resizeable: false});
    win.orientation = "column";
    win.margins = 2;
    win.spacing = 2;

    var presets = [["TL", "TC", "TR"], ["CL", "C", "CR"], ["BL", "BC", "BR"]];

    for (var row = 0; row < 3; row++) {
        var rowGroup = win.add("group");
        rowGroup.orientation = "row";
        rowGroup.margins = 0;
        rowGroup.spacing = 2;

        for (var col = 0; col < 3; col++) {
            var label = presets[row][col];
            var b = rowGroup.add("button", undefined, label, {style: "toolbutton"});
            b.minimumSize = [24, 24];
            b.maximumSize = [30, 30];

            (function (presetName) {
                b.onClick = function () {
                    app.beginUndoGroup("AE Panel - Anchor Preset");
                    try {
                        for (var i = 0; i < selectedLayers.length; i++) {
                            setAnchorPreset(selectedLayers[i], presetName);
                        }
                    } catch (e) {}
                    app.endUndoGroup();
                    win.close();
                };
            })(label);
        }
    }

    win.center();
    win.show();
}


// ============================================================================
// ADVANCED DECOMPOSE
// ============================================================================
function decomposeSelectedPrecomps_Advanced() {
    var comp = app.project.activeItem;
    if (!(comp instanceof CompItem)) {
        alert("Select a composition.");
        return;
    }

    var sel = comp.selectedLayers;
    if (!sel.length) {
        alert("Select a precomp layer.");
        return;
    }

    app.beginUndoGroup("AE Panel - Decompose");

    // Sort targets by index descending to avoid layer shifting during removal
    var targets = [];
    for (var i = 0; i < sel.length; i++) {
        if (sel[i].source instanceof CompItem) targets.push(sel[i]);
    }
    targets.sort(function (a, b) { return b.index - a.index; });

    for (var t = 0; t < targets.length; t++) {
        var preLayer = targets[t];
        var nested = preLayer.source;

        // ===================================================
        // TIME MAPPING HELPER
        // ===================================================
        // Get timeRemap property once (avoid recalculating inside loops)
        var timeRemapProp = null;
        try {
            timeRemapProp = preLayer.property("ADBE Time Remapping");
            if (timeRemapProp && !timeRemapProp.enabled) {
                timeRemapProp = null;
            }
        } catch (e) {}

        /**
         * Map a time value from nested comp to parent comp.
         * Accounts for:
         * - nested.displayStartTime (nested comp offset)
         * - preLayer.inPoint (when precomp starts in parent)
         * - preLayer.stretch (time dilation/compression)
         * - preLayer.timeRemap (if remapping is enabled)
         */
        function mapNestedTime(nestedTime) {
            var mappedTime = nestedTime;

            // Remove nested comp's display start offset
            mappedTime = mappedTime - nested.displayStartTime;

            // Apply timeRemap if enabled
            if (timeRemapProp) {
                try {
                    mappedTime = timeRemapProp.valueAtTime(mappedTime, false);
                } catch (e) {}
            }

            // Apply stretch factor (stretch is a percentage; >100 = slower, <100 = faster)
            if (preLayer.stretch && preLayer.stretch !== 100) {
                mappedTime = mappedTime * (100 / preLayer.stretch);
            }

            // Offset by precomp layer's in-point in parent composition
            mappedTime = mappedTime + preLayer.inPoint;

            return mappedTime;
        }

        // ===================================================
        // COPY LAYERS & COLLECT METADATA
        // ===================================================
        var copiedLayers = [];  // Stores {newLayer, srcLayer} pairs
        var parentRelations = []; // Stores {child, parentSrc} pairs for deferred assignment

        for (var j = nested.numLayers; j >= 1; j--) {
            var srcLayer = nested.layer(j);
            if (!srcLayer) continue;

            // Copy layer to parent composition
            var newLayer;
            try {
                newLayer = srcLayer.copyToComp(comp);
            } catch (e) {
                // Layer type not supported or other copy error
                continue;
            }

            if (!newLayer) continue;

            // ===================================================
            // SET TIME PROPERTIES (ACCURATE MAPPING)
            // ===================================================
            try {
                var srcStartTime = srcLayer.startTime;
                var srcInPoint = srcLayer.inPoint;
                var srcOutPoint = srcLayer.outPoint;

                // Map times through helper function
                newLayer.startTime = mapNestedTime(srcStartTime);
                newLayer.inPoint = mapNestedTime(srcInPoint);
                newLayer.outPoint = mapNestedTime(srcOutPoint);
            } catch (e) {
                // Use defaults if time property fails
            }

            // ===================================================
            // COPY LAYER PROPERTIES
            // ===================================================
            try { newLayer.blendingMode = srcLayer.blendingMode; } catch (e) {}
            try { newLayer.threeDLayer = srcLayer.threeDLayer; } catch (e) {}
            try { newLayer.motionBlur = srcLayer.motionBlur; } catch (e) {}
            try { newLayer.adjustmentLayer = srcLayer.adjustmentLayer; } catch (e) {}
            try { newLayer.label = srcLayer.label; } catch (e) {}
            try { newLayer.stretch = srcLayer.stretch; } catch (e) {}

            // ===================================================
            // PRESERVE TRACK MATTE RELATIONSHIPS
            // ===================================================
            try {
                if (srcLayer.hasTrackMatte) {
                    newLayer.trackMatteType = srcLayer.trackMatteType;
                }
            } catch (e) {}

            copiedLayers.push({
                newLayer: newLayer,
                srcLayer: srcLayer
            });

            // Record parent relationships for deferred restoration
            if (srcLayer.parent) {
                parentRelations.push({
                    child: newLayer,
                    parentSrc: srcLayer.parent
                });
            }
        }

        // ===================================================
        // POSITION LAYERS (INSERT WHERE PRECOMP WAS)
        // ===================================================
        for (var c = copiedLayers.length - 1; c >= 0; c--) {
            try {
                copiedLayers[c].newLayer.moveBefore(preLayer);
            } catch (e) {}
        }

        // ===================================================
        // RESTORE PARENT RELATIONSHIPS
        // Applied AFTER all layers are created to avoid invalid references
        // ===================================================
        for (var pr = 0; pr < parentRelations.length; pr++) {
            var relation = parentRelations[pr];
            var childLayer = relation.child;
            var parentSrcLayer = relation.parentSrc;

            // Find the corresponding new parent layer by source reference
            var parentNewLayer = null;
            for (var cl = 0; cl < copiedLayers.length; cl++) {
                if (copiedLayers[cl].srcLayer === parentSrcLayer) {
                    parentNewLayer = copiedLayers[cl].newLayer;
                    break;
                }
            }

            // Apply parent only if parent layer was also copied
            if (parentNewLayer) {
                try {
                    childLayer.parent = parentNewLayer;
                } catch (e) {
                    // Parent assignment failed, skip
                }
            }
        }

        // ===================================================
        // REMOVE ORIGINAL PRECOMP LAYER
        // ===================================================
        try {
            preLayer.remove();
        } catch (e) {}
    }

    app.endUndoGroup();
}


// ============================================================================
// CENTER ANCHOR POINT
// ============================================================================
function centerAnchorPoint_SelectedLayers() {
    var comp = app.project.activeItem;
    if (!comp || !(comp instanceof CompItem)) {
        alert("Please select an active composition");
        return;
    }

    var selectedLayers = comp.selectedLayers;
    if (selectedLayers.length === 0) {
        alert("Please select at least one layer");
        return;
    }

    app.beginUndoGroup("AE Panel - Center Anchor");

    var errors = [];
    var currentTime = comp.time;

    try {
        for (var i = 0; i < selectedLayers.length; i++) {
            var layer = selectedLayers[i];

            // Check if sourceRectAtTime is supported
            if (!layer.sourceRectAtTime) {
                errors.push(layer.name + ": sourceRectAtTime not supported");
                continue;
            }

            try {
                // Get the source rect at current time
                // sourceRectAtTime returns [left, top, width, height]
                var sourceRect = layer.sourceRectAtTime(currentTime, false);

                // Calculate the visual center of the layer's content in layer coordinates
                // Center = (left, top) + (width/2, height/2)
                var centerX = sourceRect[0] + sourceRect[2] / 2;
                var centerY = sourceRect[1] + sourceRect[3] / 2;

                // Cache properties to avoid repeated access
                var anchorProp = layer.anchorPoint;
                var posProp = layer.position;
                var currentAnchor = anchorProp.value;
                var currentPosition = posProp.value;

                // Calculate the offset needed to move anchor to center
                // This offset will be applied to position to compensate
                var offsetX = centerX - currentAnchor[0];
                var offsetY = centerY - currentAnchor[1];

                // Use threeDLayer property instead of checking array length
                var is3D = layer.threeDLayer;

                // Calculate new position and anchor point
                // Compensation formula: newPosition = oldPosition + (newAnchor - oldAnchor)
                var newAnchor = is3D ? [centerX, centerY, currentAnchor[2]] : [centerX, centerY];
                var newPosition = is3D
                    ? [currentPosition[0] + offsetX, currentPosition[1] + offsetY, currentPosition[2]]
                    : [currentPosition[0] + offsetX, currentPosition[1] + offsetY];

                // Apply changes: use setValueAtTime if animated, otherwise setValue
                if (posProp.numKeys > 0) {
                    posProp.setValueAtTime(currentTime, newPosition);
                } else {
                    posProp.setValue(newPosition);
                }

                if (anchorProp.numKeys > 0) {
                    anchorProp.setValueAtTime(currentTime, newAnchor);
                } else {
                    anchorProp.setValue(newAnchor);
                }

            } catch (layerError) {
                errors.push(layer.name + ": " + layerError.message);
            }
        }

    } catch (error) {
        errors.push("Fatal error: " + error.message);
    } finally {
        app.endUndoGroup();
    }

    // Show single alert with all errors at the end (prevent alert spam)
    if (errors.length > 0) {
        alert("Center Anchor Point - Issues:\n" + errors.join("\n"));
    }
}


// ============================================================================
// SCRIPTUI PANEL
// ============================================================================
function AE_Utility_Panel(thisObj) {

    function buildUI(thisObj) {

        var win = (thisObj instanceof Panel)
            ? thisObj
            : new Window("palette", " ", undefined, { resizeable: true });

        win.orientation = "column";
        win.alignChildren = ["left","top"];
        win.margins = 0;
        win.spacing = 0;

        var g = win.add("group");
        g.orientation = "column";
        g.alignChildren = ["left","top"];
        g.margins = 0;
        g.spacing = 6;

        // ---------- helpers ----------
        function getComp() {
            var c = app.project.activeItem;
            if (!(c instanceof CompItem)) {
                alert("Select a composition.");
                return null;
            }
            return c;
        }

        function perSelection(fn, allowEmpty) {
            var c = getComp();
            if (!c) return;

            var sel = c.selectedLayers;
            app.beginUndoGroup("AE Panel - Action");

            if (!sel.length && allowEmpty) fn(c, null, 0);
            else for (var i=0;i<sel.length;i++) fn(c, sel[i], i);

            app.endUndoGroup();
        }

        function btn(label, tip, fn) {
            var row = g.add("group");
            row.orientation = "row";
            row.alignChildren = ["left","center"];
            row.margins = 0;

            var b = row.add("button", undefined, label, { style:"toolbutton" });
            b.preferredSize = [40, 18];
            b.minimumSize.height = 16;
            b.maximumSize.height = 18;
            b.alignment = ["left","center"];
            b.helpTip = tip;
            b.onClick = fn;
            return b;
        }

        // ---------- buttons ----------
        btn("Null","Create Null",function(){
            perSelection(function(c,l){
                var n=c.layers.addNull(); n.label=1;
                if(l){n.startTime=l.startTime;n.inPoint=l.inPoint;n.outPoint=l.outPoint;n.moveBefore(l);}
            },true);
        });

        btn("ADJ","Adjustment Layer",function(){
            perSelection(function(c,l,i){
                var a=c.layers.addSolid([1,1,1],"Adj "+(i+1),c.width,c.height,c.pixelAspect);
                a.adjustmentLayer=true;a.label=11;
                if(l){a.startTime=l.startTime;a.inPoint=l.inPoint;a.outPoint=l.outPoint;a.moveBefore(l);}
            },true);
        });

        btn("Solid", "Create Solid (Eyedropper)", function () {

    var c = getComp();
    if (!c) return;

    var prevLayer = c.selectedLayers.length ? c.selectedLayers[0] : null;

    // Show color picker ($.colorPicker is native and cross-platform)
    var color = $.colorPicker();
    if (color < 0) return;

    app.beginUndoGroup("AE Panel - Solid");

    // Convert hex color (0xRRGGBB) to normalized RGB [0-1]
    var r = ((color >> 16) & 0xFF) / 255;
    var g = ((color >> 8) & 0xFF) / 255;
    var b = (color & 0xFF) / 255;

    // Create solid directly with converted color
    var s = c.layers.addSolid([r, g, b], "Solid", c.width, c.height, c.pixelAspect);
    s.label = 8;

    if (prevLayer) {
        s.startTime = prevLayer.startTime;
        s.inPoint   = prevLayer.inPoint;
        s.outPoint  = prevLayer.outPoint;
        s.moveBefore(prevLayer);
    } else {
        var t   = c.workAreaStart;
        var dur = c.workAreaDuration;
        if (dur === 0) dur = 1;

        s.startTime = t;
        s.inPoint   = t;
        s.outPoint  = t + dur;
    }

    app.endUndoGroup();
});

        btn("Text","Create Text",function(){
            perSelection(function(c,l,i){
                var t=c.layers.addText("Text "+(i+1)); t.label=9;
                if(l){t.startTime=l.startTime;t.inPoint=l.inPoint;t.outPoint=l.outPoint;t.moveBefore(l);}
            },true);
        });

        btn("1f","1-Frame Adjustment",function(){
            var c=getComp(); if(!c) return;
            var prevLayer=c.selectedLayers.length?c.selectedLayers[0]:null;
            app.beginUndoGroup("AE Panel - 1F Adj");
            var t=c.time;
            var frameDur=c.frameDuration;
            var a=c.layers.addSolid([1,1,1],"1f Adj",c.width,c.height,c.pixelAspect);
            a.adjustmentLayer=true;
            a.label=13;
            a.startTime=t;
            a.inPoint=t;
            a.outPoint=t+frameDur;
            if(prevLayer) a.moveBefore(prevLayer);
            app.endUndoGroup();
        });

        btn("Cam","Camera + Rig",function(){
            var c=getComp(); if(!c) return;
            app.beginUndoGroup("AE Panel - Camera Rig");
            var cam=c.layers.addCamera("Camera",[c.width/2,c.height/2]);
            var ctl=c.layers.addNull();
            ctl.name="Camera Controller";ctl.threeDLayer=true;ctl.motionBlur=true;ctl.label=16;

            if(c.selectedLayers.length){
                var sel=c.selectedLayers;
                var minIn=sel[0].inPoint,maxOut=sel[0].outPoint;
                for(var i=1;i<sel.length;i++){
                    if(sel[i].inPoint<minIn)minIn=sel[i].inPoint;
                    if(sel[i].outPoint>maxOut)maxOut=sel[i].outPoint;
                }
                cam.startTime=ctl.startTime=minIn;
                cam.inPoint=ctl.inPoint=minIn;
                cam.outPoint=ctl.outPoint=maxOut;
            }

            ctl.moveBefore(cam);cam.parent=ctl;
            app.endUndoGroup();
        });

        btn("AK","Align Keys",function(){
            var c=getComp(); if(!c) return;
            var fd=1/c.frameRate;
            app.beginUndoGroup("AE Panel - Align Keys");
            var sel=c.selectedLayers;
            for(var i=0;i<sel.length;i++){
                var props=sel[i].selectedProperties;
                for(var j=0;j<props.length;j++){
                    var p=props[j];
                    if(!p||p.numKeys<2)continue;
                    var isTR=(p.matchName==="ADBE TimeRemapping");
                    var last=p.numKeys,keys=[];
                    for(var k=1;k<=p.numKeys;k++)
                        if(p.keySelected(k)&&!(isTR&&k===last))keys.push(k);
                    if(keys.length>1){
                        var t0=p.keyTime(keys[0]),vals=[];
                        for(var m=0;m<keys.length;m++)vals.push(p.keyValue(keys[m]));
                        for(var m=keys.length-1;m>=0;m--)p.removeKey(keys[m]);
                        for(var m=0;m<vals.length;m++)p.setValueAtTime(t0+m*fd,vals[m]);
                    }
                }
            }
            app.endUndoGroup();
        });

        btn("De","Decompose Precomp",decomposeSelectedPrecomps_Advanced);

        btn("Anc","Anchor Presets",openAnchorPresetPanel);

        btn("PreComp","Precompose layers separately",function(){
            var comp = app.project.activeItem;
            if (!(comp instanceof CompItem)) {
                alert("Select a composition.");
                return;
            }

            var selectedLayers = comp.selectedLayers;
            if (!selectedLayers.length) {
                alert("Select at least one layer.");
                return;
            }

            app.beginUndoGroup("AE Panel - Precompose");

            // Collect layer data before processing
            var layerData = [];
            for (var i = 0; i < selectedLayers.length; i++) {
                var layer = selectedLayers[i];
                layerData.push({
                    index: layer.index,
                    startTime: layer.startTime,
                    inPoint: layer.inPoint,
                    outPoint: layer.outPoint
                });
            }

            // Sort by index descending to avoid shifting
            layerData.sort(function (a, b) { return b.index - a.index; });

            // Precompose each layer separately
            for (var i = 0; i < layerData.length; i++) {
                var data = layerData[i];

                // Precompose single layer—returns CompItem, not Layer
                comp.layers.precompose([data.index], "PreComp " + (i + 1), true);

                // New precomp layer replaces original at same index
                var newLayer = comp.layer(data.index);
                if (newLayer) {
                    newLayer.startTime = data.startTime;
                    newLayer.inPoint = data.inPoint;
                    newLayer.outPoint = data.outPoint;
                }
            }

            app.endUndoGroup();
        });

        btn("Presets","Anchor Presets",openAnchorPresetPanel);

        win.layout.layout(true);
        return win;
    }

    var p = buildUI(thisObj);
    if (p instanceof Window) { p.center(); p.show(); }
}

AE_Utility_Panel(this);
