// ============================================================================
// ANCHOR PRESET HELPER
// ============================================================================
function setAnchorPreset(mode, layerIndices) {
    function getTargetFromPreset(preset, left, top, width, height) {
        switch (preset) {
            case "TL": return [left, top];
            case "TC": return [left + width / 2, top];
            case "TR": return [left + width, top];
            case "CL": return [left, top + height / 2];
            case "C":  return [left + width / 2, top + height / 2];
            case "CR": return [left + width, top + height / 2];
            case "BL": return [left, top + height];
            case "BC": return [left + width / 2, top + height];
            case "BR": return [left + width, top + height];
            default: return null;
        }
    }

    var comp = app.project.activeItem;
    if (!comp || !(comp instanceof CompItem)) {
        return false;
    }

    // Rebuild layer array from indices (stable reference)
    var layersToProcess = [];
    if (layerIndices && layerIndices.length > 0) {
        for (var idx = 0; idx < layerIndices.length; idx++) {
            var layer = comp.layer(layerIndices[idx]);
            if (layer) layersToProcess.push(layer);
        }
    } else {
        layersToProcess = comp.selectedLayers;
    }
    
    if (layersToProcess.length === 0) {
        alert("No layers to process");
        return false;
    }

    var currentTime = comp.time;
    var successCount = 0;

    for (var i = 0; i < layersToProcess.length; i++) {
        var layer = layersToProcess[i];

        // Skip layers without sourceRectAtTime support
        if (typeof layer.sourceRectAtTime !== "function") continue;

        try {
            var sourceRect = layer.sourceRectAtTime(currentTime, false);
            var left = sourceRect.left, top = sourceRect.top, width = sourceRect.width, height = sourceRect.height;
            var target = getTargetFromPreset(mode, left, top, width, height);
            if (!target) return false;
            var targetX = target[0];
            var targetY = target[1];

            // Optional guard: if bounds collapse to a point, only proceed for center preset.
            if (width === 0 && height === 0 && mode !== "C") {
                $.writeln("Skipping layer with zero-size bounds for preset " + mode + ": " + layer.name);
                continue;
            }

            var is3D = layer.threeDLayer;
            var anchorPropRef = layer.anchorPoint;
            var posPropRef = layer.position;
            var currentAnchor = anchorPropRef.value;
            var currentPosition = posPropRef.value;
            if (!currentAnchor || !currentPosition) continue;

            var deltaX = targetX - currentAnchor[0];
            var deltaY = targetY - currentAnchor[1];

            var newAnchor = is3D
                ? [targetX, targetY, currentAnchor[2]]
                : [targetX, targetY];

            var anchorProp = anchorPropRef;
            var posProp = posPropRef;

            var origAnchorKeys = anchorProp.numKeys;
            if (origAnchorKeys > 0) {
                for (var a = 1; a <= origAnchorKeys; a++) {
                    var aVal = anchorProp.keyValue(a);
                    var aTime = anchorProp.keyTime(a);
                    var shiftedAnchor = is3D
                        ? [aVal[0] + deltaX, aVal[1] + deltaY, aVal[2]]
                        : [aVal[0] + deltaX, aVal[1] + deltaY];
                    anchorProp.setValueAtTime(aTime, shiftedAnchor);
                }
            } else {
                anchorProp.setValue(newAnchor);
            }

            var origPosKeys = posProp.numKeys;
            if (origPosKeys > 0) {
                for (var k = 1; k <= origPosKeys; k++) {
                    var kVal = posProp.keyValue(k);
                    var kTime = posProp.keyTime(k);
                    var shifted = is3D
                        ? [kVal[0] + deltaX, kVal[1] + deltaY, kVal[2]]
                        : [kVal[0] + deltaX, kVal[1] + deltaY];
                    posProp.setValueAtTime(kTime, shifted);
                }
            } else {
                posProp.setValue(is3D
                    ? [currentPosition[0] + deltaX, currentPosition[1] + deltaY, currentPosition[2]]
                    : [currentPosition[0] + deltaX, currentPosition[1] + deltaY]);
            }

            successCount++;

        } catch (e) {
            $.writeln("Error on " + layer.name + ": " + e.message);
        }
    }

    return successCount > 0;
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
        var mapNestedTime = function(nestedTime) {
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
        };

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
            if (typeof layer.sourceRectAtTime !== "function") {
                errors.push(layer.name + ": sourceRectAtTime not supported");
                continue;
            }

            try {
                var sourceRect = layer.sourceRectAtTime(currentTime, false);

                // sourceRectAtTime returns in anchor-relative space (anchor = origin).
                // left+width/2 and top+height/2 are the displacement from anchor to content center.
                var dx = sourceRect.left + sourceRect.width  / 2;
                var dy = sourceRect.top  + sourceRect.height / 2;

                var anchorProp      = layer.anchorPoint;
                var posProp         = layer.position;
                var currentAnchor   = anchorProp.value;
                var currentPosition = posProp.value;
                if (!currentAnchor || !currentPosition) continue;

                var is3D = layer.threeDLayer;

                var newAnchor = is3D
                    ? [currentAnchor[0] + dx, currentAnchor[1] + dy, currentAnchor[2]]
                    : [currentAnchor[0] + dx, currentAnchor[1] + dy];
                var newPosition = is3D
                    ? [currentPosition[0] + dx, currentPosition[1] + dy, currentPosition[2]]
                    : [currentPosition[0] + dx, currentPosition[1] + dy];

                var origAnchorKeys = anchorProp.numKeys;
                if (origAnchorKeys > 0) {
                    for (var a = 1; a <= origAnchorKeys; a++) {
                        var aVal  = anchorProp.keyValue(a);
                        var aTime = anchorProp.keyTime(a);
                        var shiftedAnchor = is3D
                            ? [aVal[0] + dx, aVal[1] + dy, aVal[2]]
                            : [aVal[0] + dx, aVal[1] + dy];
                        anchorProp.setValueAtTime(aTime, shiftedAnchor);
                    }
                } else {
                    anchorProp.setValue(newAnchor);
                }

                var origPosKeys = posProp.numKeys;
                if (origPosKeys > 0) {
                    for (var k = 1; k <= origPosKeys; k++) {
                        var kVal  = posProp.keyValue(k);
                        var kTime = posProp.keyTime(k);
                        var shifted = is3D
                            ? [kVal[0] + dx, kVal[1] + dy, kVal[2] + dz]
                            : [kVal[0] + dx, kVal[1] + dy];
                        posProp.setValueAtTime(kTime, shifted);
                    }
                } else {
                    var newPosition = is3D
                        ? [currentPosition[0] + dx, currentPosition[1] + dy, currentPosition[2] + dz]
                        : [currentPosition[0] + dx, currentPosition[1] + dy];
                    posProp.setValue(newPosition);
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
// RESET TRANSFORMS
// ============================================================================
function resetLayerTransforms() {
    var comp = app.project.activeItem;
    if (!comp || !(comp instanceof CompItem)) return;

    var sel = comp.selectedLayers;
    if (sel.length === 0) return;

    app.beginUndoGroup("AE Panel - Hard Reset Transforms");

    // Helper to strip keyframes, expressions, and reset the value
    function hardReset(prop, val) {
        if (prop && prop.canSetExpression) {
            // Remove all keyframes from back to front
            while (prop.numKeys > 0) {
                prop.removeKey(1);
            }
            // Clear any expressions
            if (prop.expression !== "") prop.expression = "";
            // Apply the default value
            prop.setValue(val);
        }
    }

    for (var i = 0; i < sel.length; i++) {
        var l = sel[i];

        var defaultPos = l.threeDLayer ? [comp.width/2, comp.height/2, 0] : [comp.width/2, comp.height/2];
        hardReset(l.position, defaultPos);

        var defaultScale = l.threeDLayer ? [100, 100, 100] : [100, 100];
        hardReset(l.scale, defaultScale);

        if (l.threeDLayer) {
            hardReset(l.orientation, [0, 0, 0]);
            hardReset(l.rotationX, 0);
            hardReset(l.rotationY, 0);
            hardReset(l.rotationZ, 0);
        } else {
            hardReset(l.rotation, 0);
        }

        hardReset(l.opacity, 100);
    }
    app.endUndoGroup();
}


function cropCompToSelection() {
    var comp = app.project.activeItem;
    if (!comp || !(comp instanceof CompItem)) {
        alert("Select a composition.");
        return;
    }
    
    var sel = comp.selectedLayers;
    if (sel.length === 0) {
        alert("Select at least one layer to define the crop region.");
        return;
    }

    app.beginUndoGroup("AE Panel - Crop Comp");

    try {
        var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

        for (var i = 0; i < sel.length; i++) {
            var layer = sel[i];
            if (typeof layer.sourceRectAtTime !== "function") continue;

            var rect = layer.sourceRectAtTime(comp.time, false);
            var s = layer.scale.value;
            var p = layer.position.value;
            var a = layer.anchorPoint.value;

            var scaleX = s[0] / 100;
            var scaleY = s[1] / 100;

            // Manually calculate comp-space bounds
            var left = p[0] + (rect.left - a[0]) * scaleX;
            var right = p[0] + (rect.left + rect.width - a[0]) * scaleX;
            var top = p[1] + (rect.top - a[1]) * scaleY;
            var bottom = p[1] + (rect.top + rect.height - a[1]) * scaleY;

            // Handle flipped scales
            var trueLeft = Math.min(left, right);
            var trueRight = Math.max(left, right);
            var trueTop = Math.min(top, bottom);
            var trueBottom = Math.max(top, bottom);

            if (trueLeft < minX) minX = trueLeft;
            if (trueTop < minY) minY = trueTop;
            if (trueRight > maxX) maxX = trueRight;
            if (trueBottom > maxY) maxY = trueBottom;
        }

        if (minX === Infinity) throw new Error("Could not determine bounds.");

        var buffer = 2; 
        minX = Math.floor(minX - buffer);
        minY = Math.floor(minY - buffer);
        maxX = Math.ceil(maxX + buffer);
        maxY = Math.ceil(maxY + buffer);

        var newWidth = maxX - minX;
        var newHeight = maxY - minY;

        if (newWidth <= 0 || newHeight <= 0 || newWidth > 30000 || newHeight > 30000) {
            throw new Error("Invalid crop dimensions calculated.");
        }

        var masterNull = comp.layers.addNull();
        masterNull.name = "Temp_Crop_Shift";
        var layersToUnparent = [];

        for (var k = comp.numLayers; k >= 2; k--) {
            var l = comp.layer(k);
            if (l.parent === null) {
                l.parent = masterNull;
                layersToUnparent.push(l);
            }
        }

        var currentPos = masterNull.position.value;
        masterNull.position.setValue([currentPos[0] - minX, currentPos[1] - minY, currentPos[2]]);

        for (var u = 0; u < layersToUnparent.length; u++) {
            layersToUnparent[u].parent = null;
        }
        masterNull.remove();

        comp.width = newWidth;
        comp.height = newHeight;

    } catch (e) {
        alert("Error cropping comp: " + e.message);
    } finally {
        app.endUndoGroup();
    }
}

function sequenceSelectedLayers() {
    var comp = app.project.activeItem;
    if (!comp || !(comp instanceof CompItem)) return;
    
    var sel = comp.selectedLayers;
    if (sel.length < 2) return;
    
    app.beginUndoGroup("AE Panel - Sequence Layers");
    
    // Set the time tracker to the end of the very first layer
    var nextTime = sel[0].outPoint;
    
    for (var i = 1; i < sel.length; i++) {
        var l = sel[i];
        var inOffset = l.inPoint - l.startTime; // Account for trimmed layers
        l.startTime = nextTime - inOffset;
        nextTime = l.outPoint;
    }
    
    app.endUndoGroup();
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
        win.alignChildren = "fill";
        win.margins = 0;
        win.spacing = 0;

        var g = win.add("group");
        g.orientation = "column";
        g.alignChildren = "fill";
        g.margins = 8;
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

        function btn(group, label, tip, fn, width) {
            var b = group.add("button", undefined, label, { style:"toolbutton" });
            var sz = width || 26;
            b.preferredSize = [sz, 18];
            b.minimumSize = [sz, 18];
            b.maximumSize = [sz, 18];
            b.helpTip = tip;
            b.onClick = fn;
            return b;
        }

        function addSection(title) {
            var section = g.add("group");
            section.orientation = "column";
            section.alignChildren = "fill";
            section.margins = 0;
            section.spacing = 3;

            var titleText = section.add("statictext", undefined, title);

            var btnGroup = section.add("group");
            btnGroup.orientation = "row";
            btnGroup.alignChildren = "left";
            btnGroup.margins = 0;
            btnGroup.spacing = 2;

            return { section: section, btnGroup: btnGroup };
        }

        function addSeparator() {
            var sep = g.add("panel");
            sep.alignChildren = "fill";
            sep.margins = 0;
            sep.height = 1;
            sep.minimumSize = [0, 1];
        }

        // ===== CREATE =====
        var createSec = addSection("Create");

        // Row 1: Null, ADJ
        var row1 = createSec.section.add("group");
        row1.orientation = "row";
        row1.alignChildren = "left";
        row1.margins = 0;
        row1.spacing = 2;

        btn(row1,"Null","Create Null",function(){
            perSelection(function(c,l){
                var n=c.layers.addNull(); n.label=1;
                if(l){n.startTime=l.startTime;n.inPoint=l.inPoint;n.outPoint=l.outPoint;n.moveBefore(l);}
            },true);
        });

        btn(row1,"ADJ","Adjustment Layer",function(){
            perSelection(function(c,l,i){
                var a=c.layers.addSolid([1,1,1],"Adj "+(i+1),c.width,c.height,c.pixelAspect);
                a.adjustmentLayer=true;a.label=11;
                if(l){a.startTime=l.startTime;a.inPoint=l.inPoint;a.outPoint=l.outPoint;a.moveBefore(l);}
            },true);
        });

        // Row 2: Solid, Text
        var row2 = createSec.section.add("group");
        row2.orientation = "row";
        row2.alignChildren = "left";
        row2.margins = 0;
        row2.spacing = 2;

        btn(row2, "Solid", "Create Solid (Eyedropper)", function () {
            var c = getComp();
            if (!c) return;
            var prevLayer = c.selectedLayers.length ? c.selectedLayers[0] : null;
            var color = $.colorPicker();
            if (color < 0) return;
            app.beginUndoGroup("AE Panel - Solid");
            var r = ((color >> 16) & 0xFF) / 255;
            var gb = ((color >> 8) & 0xFF) / 255;
            var b = (color & 0xFF) / 255;
            var s = c.layers.addSolid([r, gb, b], "Solid", c.width, c.height, c.pixelAspect);
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

        btn(row2,"Text","Create Text",function(){
            perSelection(function(c,l,i){
                var t=c.layers.addText("Text "+(i+1)); t.label=9;
                if(l){t.startTime=l.startTime;t.inPoint=l.inPoint;t.outPoint=l.outPoint;t.moveBefore(l);}
            },true);
        });

        addSeparator();

        // ===== UTILITIES =====
        var utilSec = addSection("Utilities");
        
        btn(utilSec.btnGroup,"1f","1-Frame Adjustment",function(){
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

        btn(utilSec.btnGroup,"AK","Align Keys",function(){
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

        btn(utilSec.btnGroup,"Rst","Reset Transforms (Pos, Scale, Rot, Opacity)",resetLayerTransforms,25);

        addSeparator();

        // ===== CAMERA =====
        var camSec = addSection("Camera");
        btn(camSec.btnGroup,"Cam","Camera + Rig",function(){
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

        addSeparator();

        // ===== LAYER OPS =====
        var layerSec = addSection("Layer Ops");
        btn(layerSec.btnGroup,"De","Decompose Precomp",decomposeSelectedPrecomps_Advanced);

        btn(layerSec.btnGroup,"PreComp","Precompose layers separately",function(){
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

            layerData.sort(function (a, b) { return b.index - a.index; });

            for (var i = 0; i < layerData.length; i++) {
                var data = layerData[i];
                comp.layers.precompose([data.index], "PreComp " + (i + 1), true);
                var newLayer = comp.layer(data.index);
                if (newLayer) {
                    newLayer.startTime = data.startTime;
                    newLayer.inPoint = data.inPoint;
                    newLayer.outPoint = data.outPoint;
                }
            }

            app.endUndoGroup();
        });

        addSeparator();

        // ===== ANCHOR PRESETS (COLLAPSIBLE) =====
        var anchorSec = g.add("group");
        anchorSec.orientation = "column";
        anchorSec.alignChildren = "fill";
        anchorSec.margins = 0;
        anchorSec.spacing = 3;

        // Collapsible header button
        var anchorHeaderBtn = anchorSec.add("button", undefined, "Anchor ▼");
        anchorHeaderBtn.preferredSize = [undefined, 18];
        anchorHeaderBtn.helpTip = "Toggle Anchor Presets";

        // Content group (hidden by default)
        var anchorContent = anchorSec.add("group");
        anchorContent.orientation = "column";
        anchorContent.alignChildren = "fill";
        anchorContent.margins = 0;
        anchorContent.spacing = 2;
        anchorContent.visible = false;  // Start collapsed
        anchorContent.maximumSize = [9999, 0]; // Force 0 height when collapsed

        var isExpanded = false;

        anchorHeaderBtn.onClick = function() {
            isExpanded = !isExpanded;
            anchorContent.visible = isExpanded;
            anchorContent.maximumSize = isExpanded ? [9999, 9999] : [9999, 0];
            anchorHeaderBtn.text = isExpanded ? "Anchor ▲" : "Anchor ▼";
            win.layout.layout(true);
        };

        // 3x3 Anchor Preset Grid
        var presets = [["TL", "TC", "TR"], ["CL", "C", "CR"], ["BL", "BC", "BR"]];

        for (var row = 0; row < 3; row++) {
            var rowGroup = anchorContent.add("group");
            rowGroup.orientation = "row";
            rowGroup.alignChildren = "left";
            rowGroup.margins = 0;
            rowGroup.spacing = 2;

            for (var col = 0; col < 3; col++) {
                var label = presets[row][col];
                var b = rowGroup.add("button", undefined, label, {style: "toolbutton"});
                b.preferredSize = [18, 18];
                b.minimumSize = [18, 18];
                b.maximumSize = [18, 18];

                (function (presetMode) {
                    b.onClick = function () {
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

                        var savedLayerIndices = [];
                        for (var s = 0; s < selectedLayers.length; s++) {
                            savedLayerIndices.push(selectedLayers[s].index);
                        }

                        app.beginUndoGroup("Anchor Preset");
                        setAnchorPreset(presetMode, savedLayerIndices);
                        app.endUndoGroup();
                    };
                })(label);
            }
        }

        addSeparator();

        // ===== TOOLS PRESETS (COLLAPSIBLE) =====
        var toolsSec = g.add("group");
        toolsSec.orientation = "column";
        toolsSec.alignChildren = "fill";
        toolsSec.margins = 0;
        toolsSec.spacing = 3;

        var toolsHeaderBtn = toolsSec.add("button", undefined, "Tools ▼");
        toolsHeaderBtn.preferredSize = [undefined, 18];
        toolsHeaderBtn.helpTip = "Toggle Advanced Tools";

        var toolsContent = toolsSec.add("group");
        toolsContent.orientation = "column"; // Changed to column to hold multiple rows
        toolsContent.alignChildren = "left";
        toolsContent.margins = 0;
        toolsContent.spacing = 2;
        toolsContent.visible = false;
        toolsContent.maximumSize = [9999, 0];

        var isToolsExpanded = false;

        toolsHeaderBtn.onClick = function() {
            isToolsExpanded = !isToolsExpanded;
            toolsContent.visible = isToolsExpanded;
            toolsContent.maximumSize = isToolsExpanded ? [9999, 9999] : [9999, 0];
            toolsHeaderBtn.text = isToolsExpanded ? "Tools ▲" : "Tools ▼";
            win.layout.layout(true);
        };

        // --- ROW 1: Basic Tools ---
        var tRow1 = toolsContent.add("group");
        tRow1.orientation = "row";
        tRow1.spacing = 2;
        btn(tRow1, "Crop", "Crop Comp to Bounding Box", cropCompToSelection, 35);
        btn(tRow1, "Seq", "Sequence Layers End-to-End", sequenceSelectedLayers, 30);

        // --- ROW 2: Custom Script Launcher ---
        var tRow2 = toolsContent.add("group");
        tRow2.orientation = "row";
        tRow2.spacing = 2;

        // Load saved tools from AE preferences
        var myFavs = [];
        if (app.settings.haveSetting("MyAEPanel", "FavTools")) {
            myFavs = app.settings.getSetting("MyAEPanel", "FavTools").split("||");
        } else {
            myFavs = ["Menu:Align", "Menu:Character"]; // Defaults
        }

        var ddLauncher = tRow2.add("dropdownlist", undefined, myFavs);
        if (ddLauncher.items.length > 0) ddLauncher.selection = 0;
        ddLauncher.preferredSize.width = 80;

        function saveLauncherSettings() {
            var arr = [];
            for(var i=0; i<ddLauncher.items.length; i++) arr.push(ddLauncher.items[i].text);
            app.settings.saveSetting("MyAEPanel", "FavTools", arr.join("||"));
        }

        btn(tRow2, "▶", "Run Selected Tool", function(){
            if (!ddLauncher.selection) return;
            var sel = ddLauncher.selection.text;
            app.beginUndoGroup("AE Panel - Launch");

            if (sel.indexOf("Menu:") === 0) {
                var cmd = sel.substring(5);
                var id = app.findMenuCommandId(cmd);
                if (id) app.executeCommand(id);
                else alert("Could not find Menu Command: " + cmd);
            } else if (sel.indexOf("File:") === 0) {
                var f = new File(sel.substring(5));
                if (f.exists) $.evalFile(f);
                else alert("Could not find script file:\n" + f.fsName);
            }

            app.endUndoGroup();
        }, 20);

        btn(tRow2, "+", "Add Script or Plugin", function(){
            var type = confirm("Click YES to add a Menu Plugin (e.g. 'Align', 'Duik').\nClick NO to browse for a Script File (.jsx).");
            if (type) {
                var cmd = prompt("Enter exact Menu Command name:", "Align");
                if (cmd) {
                    ddLauncher.add("item", "Menu:" + cmd);
                    ddLauncher.selection = ddLauncher.items.length - 1;
                    saveLauncherSettings();
                }
            } else {
                var f = File.openDialog("Select a Script", "*.jsx;*.jsxbin");
                if (f) {
                    ddLauncher.add("item", "File:" + f.fsName);
                    ddLauncher.selection = ddLauncher.items.length - 1;
                    saveLauncherSettings();
                }
            }
        }, 20);

        btn(tRow2, "-", "Remove Selected", function(){
            if (ddLauncher.selection && ddLauncher.items.length > 0) {
                ddLauncher.remove(ddLauncher.selection);
                if(ddLauncher.items.length > 0) ddLauncher.selection = 0;
                saveLauncherSettings();
            }
        }, 20);

        win.layout.layout(true);
        return win;
    }

    var p = buildUI(thisObj);
    if (p instanceof Window) { p.center(); p.show(); }
}

AE_Utility_Panel(this);