(function(thisObj) {

// ============================================================================
// API ABSTRACTION WRAPPER
// ============================================================================
var AE = {
    getActiveComp: function() {
        var c = app.project.activeItem;
        return (c instanceof CompItem) ? c : null;
    },
    requireComp: function() {
        var c = app.project.activeItem;
        if (!(c instanceof CompItem)) {
            alert("Select a composition.");
            return null;
        }
        return c;
    },
    requireSelection: function(comp) {
        if (!comp) return null;
        var sel = comp.selectedLayers;
        if (!sel.length) {
            alert("Select at least one layer.");
            return null;
        }
        return sel;
    }
};

// ============================================================================
// TRANSFORM DEFAULTS HELPER
// ============================================================================
var TransformDefaults = {
    position: function(layer, comp) {
        return layer.threeDLayer ? [comp.width/2, comp.height/2, 0] : [comp.width/2, comp.height/2];
    },
    scale: function(layer) {
        return layer.threeDLayer ? [100,100,100] : [100,100];
    },
    rotation: function(layer) {
        return layer.threeDLayer ? [0,0,0] : 0;
    }
};

// ============================================================================
// PROGRESS FEEDBACK HELPER
// ============================================================================
/**
 * Update progress bar and log feedback.
 * ExtendScript-safe progress simulation for heavy operations.
 *
 * @param {number} current - Current iteration/count
 * @param {number} total - Total iterations/count
 * @param {string} label - Optional label for logging (e.g., "Processing layers")
 */
function updateProgress(current, total, label) {
    if (app && app.setProgressBar) {
        try {
            app.setProgressBar(current, total);
        } catch (e) {}
    }

    // Log progress for debugging
    if (label) {
        $.writeln(label + " (" + current + "/" + total + ")");
    }
}

// ============================================================================
// KEYFRAME OPTIMIZATION HELPER
// ============================================================================
/**
 * Efficiently shift keyframe values by caching all keys first.
 * Preserves interpolation types and easing.
 * Avoids repeated property access calls which are expensive in ExtendScript.
 *
 * @param {Property} prop - The property to shift keyframes on
 * @param {number} dx - X offset
 * @param {number} dy - Y offset
 * @param {number} dz - Z offset (for 3D)
 * @param {boolean} is3D - Whether property is 3D
 */
function shiftKeyframes(prop, dx, dy, dz, is3D) {
    if (!prop || prop.numKeys === 0) return;

    // STEP 1: Cache all keyframe data first (single pass read)
    // Include interpolation and easing info to preserve animation curves
    var keyData = [];
    for (var k = 1; k <= prop.numKeys; k++) {
        var keyInfo = {
            time: prop.keyTime(k),
            value: prop.keyValue(k),
            inInterp: prop.keyInInterpolationType(k),
            outInterp: prop.keyOutInterpolationType(k),
            easeIn: null,
            easeOut: null
        };

        // Capture temporal easing if available (not all property types support this)
        try {
            keyInfo.easeIn = prop.keyInTemporalEase(k);
            keyInfo.easeOut = prop.keyOutTemporalEase(k);
        } catch (e) {
            // Some properties don't support temporal easing; that's OK
        }

        keyData.push(keyInfo);
    }

    // STEP 2: Remove keys in reverse order (avoids index shifting)
    for (var k = prop.numKeys; k >= 1; k--) {
        prop.removeKey(k);
    }

    // STEP 3: Reapply with shifted values and original easing
    for (var k = 0; k < keyData.length; k++) {
        var old = keyData[k].value;
        var shifted;

        if (is3D) {
            shifted = [old[0] + dx, old[1] + dy, old[2] + (dz || 0)];
        } else {
            shifted = [old[0] + dx, old[1] + dy];
        }

        // Add key at new time with shifted value
        prop.setValueAtTime(keyData[k].time, shifted);
        var newKeyIndex = prop.numKeys;

        // STEP 4: Restore interpolation types
        try {
            prop.setInterpolationTypeAtKey(newKeyIndex, keyData[k].inInterp, keyData[k].outInterp);
        } catch (e) {
            // Interpolation type restoration failed (rare); continue
        }

        // STEP 5: Restore temporal easing if it was present
        if (keyData[k].easeIn && keyData[k].easeOut) {
            try {
                prop.setTemporalEaseAtKey(newKeyIndex, keyData[k].easeIn, keyData[k].easeOut);
            } catch (e) {
                // Temporal easing not supported for this property; that's OK
            }
        }
    }
}


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

    var comp = AE.requireComp();
    if (!comp) return false;

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

            // Use optimized keyframe helper
            if (anchorProp.numKeys > 0) {
                shiftKeyframes(anchorProp, deltaX, deltaY, 0, is3D);
            } else {
                anchorProp.setValue(newAnchor);
            }

            if (posProp.numKeys > 0) {
                shiftKeyframes(posProp, deltaX, deltaY, 0, is3D);
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
    var comp = AE.requireComp();
    if (!comp) return;

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

        // PROGRESS: Update every iteration using reusable helper
        updateProgress(t + 1, targets.length, "Decomposing precomps");

        // UI REFRESH: Force refresh every 5 iterations to prevent UI freeze
        if (t % 5 === 0) {
            app.refresh();
        }

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
            // COPY EFFECTS
            // ===================================================
            try {
                var srcEffects = srcLayer.property("ADBE Effect Parade");
                var dstEffects = newLayer.property("ADBE Effect Parade");
                if (srcEffects && dstEffects && srcEffects.numProperties > 0) {
                    for (var ef = 1; ef <= srcEffects.numProperties; ef++) {
                        try {
                            srcEffects.property(ef).copyToComp(comp);
                            var copiedEffect = comp.layer(1).property("ADBE Effect Parade").property(
                                comp.layer(1).property("ADBE Effect Parade").numProperties
                            );
                            if (copiedEffect) {
                                copiedEffect.moveTo(dstEffects.numProperties + 1);
                            }
                        } catch (efErr) {
                            $.writeln("Could not copy effect " + ef + " on layer '" + srcLayer.name + "': " + efErr.message);
                        }
                    }
                }
            } catch (e) {
                $.writeln("Effect copy failed for layer '" + srcLayer.name + "': " + e.message);
            }

            // ===================================================
            // COPY LAYER STYLES
            // ===================================================
            try {
                var srcStyles = srcLayer.property("ADBE Layer Styles");
                var dstStyles = newLayer.property("ADBE Layer Styles");
                if (srcStyles && dstStyles && srcStyles.numProperties > 0) {
                    for (var st = 1; st <= srcStyles.numProperties; st++) {
                        try {
                            var srcStyle = srcStyles.property(st);
                            var dstStyle = dstStyles.property(st);
                            if (srcStyle && dstStyle && srcStyle.enabled) {
                                dstStyle.enabled = true;
                                for (var sp = 1; sp <= srcStyle.numProperties; sp++) {
                                    try {
                                        var srcStyleProp = srcStyle.property(sp);
                                        var dstStyleProp = dstStyle.property(sp);
                                        if (srcStyleProp && dstStyleProp &&
                                            srcStyleProp.propertyValueType !==
                                            PropertyValueType.NO_VALUE) {
                                            dstStyleProp.setValue(srcStyleProp.value);
                                        }
                                    } catch (spErr) {}
                                }
                            }
                        } catch (stErr) {
                            $.writeln("Could not copy style " + st + " on layer '" + srcLayer.name + "': " + stErr.message);
                        }
                    }
                }
            } catch (e) {
                $.writeln("Layer style copy failed for layer '" + srcLayer.name + "': " + e.message);
            }

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

    // Clear/reset progress bar after operation completes
    updateProgress(targets.length, targets.length, "Decompose complete");
    if (app && app.setProgressBar) {
        try {
            app.setProgressBar(0, 100);
        } catch (e) {}
    }
}



// ============================================================================
// CENTER ANCHOR POINT
// ============================================================================
function centerAnchorPoint_SelectedLayers() {
    var comp = AE.requireComp();
    if (!comp) return;

    var selectedLayers = AE.requireSelection(comp);
    if (!selectedLayers) return;

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
                    shiftKeyframes(anchorProp, dx, dy, 0, is3D);
                } else {
                    anchorProp.setValue(newAnchor);
                }

                var origPosKeys = posProp.numKeys;
                if (origPosKeys > 0) {
                    shiftKeyframes(posProp, dx, dy, 0, is3D);
                } else {
                    var newPosition = is3D
                        ? [currentPosition[0] + dx, currentPosition[1] + dy, currentPosition[2]]
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
// Helper to strip keyframes, expressions, and reset the value
function hardReset(prop, val) {
    if (prop && prop.canSetExpression) {
        while (prop.numKeys > 0) {
            prop.removeKey(1);
        }
        if (prop.expression !== "") prop.expression = "";
        prop.setValue(val);
    }
}

function resetLayerTransforms() {
    var comp = AE.requireComp();
    if (!comp) return;

    var sel = comp.selectedLayers;
    if (sel.length === 0) return;

    app.beginUndoGroup("AE Panel - Hard Reset Transforms");

    for (var i = 0; i < sel.length; i++) {
        var l = sel[i];

        hardReset(l.position, TransformDefaults.position(l, comp));
        hardReset(l.scale, TransformDefaults.scale(l));

        if (l.threeDLayer) {
            hardReset(l.orientation, TransformDefaults.rotation(l));
            hardReset(l.rotationX, 0);
            hardReset(l.rotationY, 0);
            hardReset(l.rotationZ, 0);
        } else {
            hardReset(l.rotation, TransformDefaults.rotation(l));
        }

        hardReset(l.opacity, 100);
    }
    app.endUndoGroup();
}


function cropCompToSelection() {
    var comp = AE.requireComp();
    if (!comp) return;

    var sel = AE.requireSelection(comp);
    if (!sel) return;

    app.beginUndoGroup("AE Panel - Crop Comp");

    try {
        var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        var validLayersFound = 0;

        // IMPROVED: Handle rotation and edge cases by converting all 4 corners to comp space
        for (var i = 0; i < sel.length; i++) {
            var layer = sel[i];

            // PROGRESS: Update progress bar every layer
            updateProgress(i + 1, sel.length, "Calculating bounds");

            // UI REFRESH: Force refresh every 3 layers to prevent UI freeze during large crops
            if (i % 3 === 0) {
                app.refresh();
            }

            // SAFETY: Skip layers that don't support sourceRectAtTime
            if (typeof layer.sourceRectAtTime !== "function") {
                $.writeln("Skipping layer '" + layer.name + "': sourceRectAtTime not supported");
                continue;
            }

            // SAFETY: Skip invisible layers (optional but prevents unexpected results)
            if (!layer.enabled) {
                $.writeln("Skipping disabled layer '" + layer.name + "'");
                continue;
            }

            try {
                var rect = layer.sourceRectAtTime(comp.time, false);

                // Guard against invalid rectangles
                if (!rect || rect.width <= 0 || rect.height <= 0) {
                    $.writeln("Skipping layer '" + layer.name + "': invalid source rect");
                    continue;
                }

                // Get transform properties
                var a = layer.anchorPoint.value;

                if (!a) continue;

                // Define the 4 corners in layer space (relative to anchor point)
                var corners = [
                    [rect.left - a[0], rect.top - a[1]],
                    [rect.left + rect.width - a[0], rect.top - a[1]],
                    [rect.left + rect.width - a[0], rect.top + rect.height - a[1]],
                    [rect.left - a[0], rect.top + rect.height - a[1]]
                ];

                // Convert each corner to comp space (handles rotation, scale, position, 3D)
                for (var c = 0; c < corners.length; c++) {
                    var layerPt = corners[c];
                    // Use toComp to convert to composition space (handles all transforms including rotation)
                    var compPt = layer.toComp([layerPt[0], layerPt[1], 0]);

                    // GUARD: Skip invalid coordinate (NaN or Infinity)
                    if (isNaN(compPt[0]) || isNaN(compPt[1]) || !isFinite(compPt[0]) || !isFinite(compPt[1])) {
                        continue;
                    }

                    if (compPt[0] < minX) minX = compPt[0];
                    if (compPt[0] > maxX) maxX = compPt[0];
                    if (compPt[1] < minY) minY = compPt[1];
                    if (compPt[1] > maxY) maxY = compPt[1];
                }

                validLayersFound++;

            } catch (layerError) {
                // Log error but continue processing other layers
                $.writeln("Error processing layer '" + layer.name + "': " + layerError.message);
                continue;
            }
        }

        // SAFETY: Ensure we found at least one valid layer
        if (validLayersFound === 0 || minX === Infinity || maxX === -Infinity) {
            throw new Error("Could not determine crop bounds. Ensure selected layers have visible content.");
        }

        // Add small buffer for safety and rounding
        var buffer = 2;
        minX = Math.floor(minX - buffer);
        minY = Math.floor(minY - buffer);
        maxX = Math.ceil(maxX + buffer);
        maxY = Math.ceil(maxY + buffer);

        var newWidth = maxX - minX;
        var newHeight = maxY - minY;

        // SAFETY: Validate final dimensions
        if (newWidth <= 0 || newHeight <= 0 || newWidth > 30000 || newHeight > 30000) {
            throw new Error("Invalid crop dimensions (" + newWidth + "x" + newHeight + "). Check layer bounds and try again.");
        }

        // Shift all layers to new origin using temporary null
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

        // Apply new dimensions
        comp.width = newWidth;
        comp.height = newHeight;

        $.writeln("Crop complete: " + newWidth + "x" + newHeight + " (from " + validLayersFound + " layer(s))");

    } catch (e) {
        alert("Error cropping comp: " + e.message);
        $.writeln("Crop operation failed: " + e.message);
    } finally {
        app.endUndoGroup();

        // Reset progress bar after crop operation
        if (app && app.setProgressBar) {
            try {
                app.setProgressBar(0, 100);
            } catch (e) {}
        }
    }
}

function sequenceSelectedLayers() {
    var comp = AE.requireComp();
    if (!comp) return;

    var sel = comp.selectedLayers;
    if (sel.length < 2) return;

    // Sort layers by index to ensure proper sequencing order
    var selArray = [];
    for (var i = 0; i < sel.length; i++) selArray.push(sel[i]);
    selArray.sort(function(a, b) { return a.index - b.index; });

    app.beginUndoGroup("AE Panel - Sequence Layers");

    // Set the time tracker to the end of the very first layer
    var nextTime = selArray[0].outPoint;

    for (var i = 1; i < selArray.length; i++) {
        var l = selArray[i];
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
        g.margins = 6;
        g.spacing = 4;

        // ---------- helpers ----------
        function getComp() {
            return AE.requireComp();
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
            titleText.alignment = ["left", "center"];

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
        var createSec = addSection("Create Layers");

        var createRow = createSec.section.add("group");
        createRow.orientation = "row";
        createRow.alignChildren = "left";
        createRow.margins = 0;
        createRow.spacing = 3;

        // STYLE: Apply bold header styling for consistency with other sections
        var createLabel = createSec.section.children[0];
        try {
            createLabel.graphics.font = ScriptUI.newFont("Arial", "BOLD", 11);
        } catch (e) {}

        btn(createRow,"Null","Create a null object for parenting and control", function(){
            perSelection(function(c,l){
                var n=c.layers.addNull(); n.label=1;
                if(l){
                    try {
                        var layerIn=Math.min(l.inPoint,l.outPoint);
                        var layerOut=Math.max(l.inPoint,l.outPoint);
                        if(!isFinite(layerIn)||!isFinite(layerOut)||layerOut<=layerIn) throw new Error("Invalid layer timing");
                        n.startTime=Math.min(l.startTime,layerIn);
                        n.inPoint=layerIn;
                        n.outPoint=layerOut;
                    } catch (timingErr) {
                        n.startTime=c.workAreaStart;
                        n.inPoint=c.workAreaStart;
                        n.outPoint=c.workAreaStart+c.workAreaDuration;
                    }
                    n.moveBefore(l);
                    if(l.threeDLayer===true) n.threeDLayer=true;
                    try {
                        var worldPos=l.toWorld(l.anchorPoint.value);
                        n.position.setValue(l.threeDLayer ? [worldPos[0], worldPos[1], worldPos[2]] : [worldPos[0], worldPos[1]]);
                    } catch (e) {
                        try { n.position.setValue(l.position.value); } catch (e2) {}
                    }
                    l.parent=n;
                }
            },true);
        }, 38);

        btn(createRow,"Adj Layer","Create adjustment layer (white solid) for effects", function(){
            perSelection(function(c,l,i){
                var a=c.layers.addSolid([1,1,1],"Adj "+(i+1),c.width,c.height,c.pixelAspect);
                a.adjustmentLayer=true;a.label=11;
                if(l){a.startTime=l.startTime;a.inPoint=l.inPoint;a.outPoint=l.outPoint;a.moveBefore(l);}
            },true);
        }, 50);

        btn(createRow, "Solid", "Create a new solid layer", function() {
            var c = AE.requireComp();
            if (!c) return;
            app.beginUndoGroup("AE Panel - Solid");
            var countBefore = c.numLayers;
            app.executeCommand(2038);
            app.endUndoGroup();
        }, 38);

        btn(createRow,"Text","Create text layer for typography and titles", function(){
            perSelection(function(c,l,i){
                var t=c.layers.addText("Text "+(i+1)); t.label=9;
                if(l){t.startTime=l.startTime;t.inPoint=l.inPoint;t.outPoint=l.outPoint;t.moveBefore(l);}
            },true);
        }, 38);

        addSeparator();

        // ===== UTILITIES =====
        var utilSec = addSection("Utilities");

        // STYLE: Apply bold header styling for consistency with other sections
        var utilLabel = utilSec.section.children[0];
        try {
            utilLabel.graphics.font = ScriptUI.newFont("Arial", "BOLD", 11);
        } catch (e) {}

        btn(utilSec.btnGroup, "1F Adj", "Create single-frame adjustment layer at playhead", function(){
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
        }, 50);

        btn(utilSec.btnGroup, "Align Keys", "Snap selected keyframes to first key (1-frame spacing)", function(){
            var c=getComp(); if(!c) return;
            var fd=1/c.frameRate;
            app.beginUndoGroup("AE Panel - Align Keys");
            var sel=c.selectedLayers;
            for(var i=0;i<sel.length;i++){
                // UI REFRESH: Update progress and refresh UI every 3 layers
                if (i % 3 === 0) {
                    updateProgress(i + 1, sel.length, "Aligning keyframes");
                    app.refresh();
                }

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
            // Reset progress bar after operation
            if (app && app.setProgressBar) {
                try {
                    app.setProgressBar(0, 100);
                } catch (e) {}
            }
        }, 55);

        addSeparator();

        // ===== TRANSFORM (COLLAPSIBLE) =====
        var resetSec = g.add("group");
        resetSec.orientation = "column";
        resetSec.alignChildren = "fill";
        resetSec.margins = 0;
        resetSec.spacing = 4;

        var resetHeaderBtn = resetSec.add("button", undefined, "Transform Reset ▼");
        resetHeaderBtn.preferredSize = [undefined, 20];
        resetHeaderBtn.helpTip = "Reset individual transform properties or all at once";

        var resetContent = resetSec.add("group");
        resetContent.orientation = "column";
        resetContent.alignChildren = "left";
        resetContent.margins = 0;
        resetContent.spacing = 2;
        resetContent.visible = false;
        resetContent.maximumSize = [9999, 0];

        var isResetExpanded = false;

        resetHeaderBtn.onClick = function() {
            isResetExpanded = !isResetExpanded;
            resetContent.visible = isResetExpanded;
            resetContent.maximumSize = isResetExpanded ? [9999, 9999] : [9999, 0];
            resetHeaderBtn.text = isResetExpanded ? "Transform Reset ▲" : "Transform Reset ▼";
            win.layout.layout(true);
        };

        var resetRow = resetContent.add("group");
        resetRow.orientation = "row";
        resetRow.alignChildren = "left";
        resetRow.margins = 0;
        resetRow.spacing = 3;

        btn(resetRow, "Position", "Reset position to center of composition", function(){
            var c = AE.requireComp(); if(!c) return;
            var sel = c.selectedLayers; if(sel.length === 0) return;
            app.beginUndoGroup("AE Panel - Reset Position");
            for (var i = 0; i < sel.length; i++) {
                var l = sel[i];
                hardReset(l.position, TransformDefaults.position(l, c));
            }
            app.endUndoGroup();
        }, 50);

        btn(resetRow, "Scale", "Reset scale to 100% (unscaled)", function(){
            var c = AE.requireComp(); if(!c) return;
            var sel = c.selectedLayers; if(sel.length === 0) return;
            app.beginUndoGroup("AE Panel - Reset Scale");
            for (var i = 0; i < sel.length; i++) {
                var l = sel[i];
                hardReset(l.scale, TransformDefaults.scale(l));
            }
            app.endUndoGroup();
        }, 45);

        btn(resetRow, "Rotation", "Reset rotation to 0 degrees (unrotated)", function(){
            var c = AE.requireComp(); if(!c) return;
            var sel = c.selectedLayers; if(sel.length === 0) return;
            app.beginUndoGroup("AE Panel - Reset Rotation");
            for (var i = 0; i < sel.length; i++) {
                var l = sel[i];
                if (l.threeDLayer) {
                    hardReset(l.orientation, TransformDefaults.rotation(l));
                    hardReset(l.rotationX, 0);
                    hardReset(l.rotationY, 0);
                    hardReset(l.rotationZ, 0);
                } else {
                    hardReset(l.rotation, TransformDefaults.rotation(l));
                }
            }
            app.endUndoGroup();
        }, 50);

        btn(resetRow, "Opacity", "Reset opacity to 100% (fully opaque)", function(){
            var c = AE.requireComp(); if(!c) return;
            var sel = c.selectedLayers; if(sel.length === 0) return;
            app.beginUndoGroup("AE Panel - Reset Opacity");
            for (var i = 0; i < sel.length; i++) {
                hardReset(sel[i].opacity, 100);
            }
            app.endUndoGroup();
        }, 50);

        btn(resetRow, "Reset All", "Reset all: position, scale, rotation, and opacity", function(){
            resetLayerTransforms();
        }, 55);

        addSeparator();

        // ===== CAMERA =====
        var camSec = addSection("Camera");

        // STYLE: Apply bold header styling for consistency with other sections
        var camLabel = camSec.section.children[0];
        try {
            camLabel.graphics.font = ScriptUI.newFont("Arial", "BOLD", 11);
        } catch (e) {}

        btn(camSec.btnGroup,"Camera Rig","Create camera with null controller (auto-frame selected layers)", function(){
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
        }, 70);

        addSeparator();

        // ===== ANCHOR PRESETS (COLLAPSIBLE) =====
        var anchorSec = g.add("group");
        anchorSec.orientation = "column";
        anchorSec.alignChildren = "fill";
        anchorSec.margins = 0;
        anchorSec.spacing = 4;

        // Collapsible header button
        var anchorHeaderBtn = anchorSec.add("button", undefined, "Anchor Point Presets ▼");
        anchorHeaderBtn.preferredSize = [undefined, 20];
        anchorHeaderBtn.helpTip = "Set anchor point to preset positions (TL=top-left, C=center, BR=bottom-right, etc.)";

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
            anchorHeaderBtn.text = isExpanded ? "Anchor Point Presets ▲" : "Anchor Point Presets ▼";
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
                        var comp = AE.requireComp();
                        if (!comp) return;
                        var selectedLayers = AE.requireSelection(comp);
                        if (!selectedLayers) return;

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
        toolsSec.spacing = 4;

        var toolsHeaderBtn = toolsSec.add("button", undefined, "Advanced Tools ▼");
        toolsHeaderBtn.preferredSize = [undefined, 20];
        toolsHeaderBtn.helpTip = "Decompose, crop, sequence layers, and plugin launcher";

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
            toolsHeaderBtn.text = isToolsExpanded ? "Advanced Tools ▲" : "Advanced Tools ▼";
            win.layout.layout(true);
        };

        // --- ROW 1: Layer Ops ---
        var toolsLayerSec = toolsContent.add("group");
        toolsLayerSec.orientation = "column";
        toolsLayerSec.alignChildren = "left";
        toolsLayerSec.margins = 0;
        toolsLayerSec.spacing = 2;

        var layerOpsLabel = toolsLayerSec.add("statictext", undefined, "Layer Operations");
        // SAFE: Use try-catch for font styling; fallback to default if unavailable
        try {
            layerOpsLabel.graphics.font = ScriptUI.newFont("Arial", "BOLD", 11);
        } catch (e) {
            // Fallback to system default font
        }

        var tLayerRow = toolsLayerSec.add("group");
        tLayerRow.orientation = "row";
        tLayerRow.spacing = 3;
        btn(tLayerRow, "Decomp", "Decompose precomp into parent composition (preserves keyframes & effects)", decomposeSelectedPrecomps_Advanced, 48);

        btn(tLayerRow, "Precomp", "Precompose selected layers separately with individual names", function(){
            var comp = AE.requireComp();
            if (!comp) return;

            var selectedLayers = AE.requireSelection(comp);
            if (!selectedLayers) return;

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
        }, 48);

        // --- ROW 2: Comp Tools ---
        var toolsCompSec = toolsContent.add("group");
        toolsCompSec.orientation = "column";
        toolsCompSec.alignChildren = "left";
        toolsCompSec.margins = 0;
        toolsCompSec.spacing = 2;

        var compToolsLabel = toolsCompSec.add("statictext", undefined, "Composition Tools");
        // SAFE: Use try-catch for font styling; fallback to default if unavailable
        try {
            compToolsLabel.graphics.font = ScriptUI.newFont("Arial", "BOLD", 11);
        } catch (e) {
            // Fallback to system default font
        }

        var tRow1 = toolsCompSec.add("group");
        tRow1.orientation = "row";
        tRow1.spacing = 3;
        btn(tRow1, "Crop Comp", "Crop composition to layer bounds (supports rotation & scale)", cropCompToSelection, 60);
        btn(tRow1, "Sequence", "Arrange selected layers end-to-end (no gaps)", sequenceSelectedLayers, 55);

        // --- ROW 3: Plugin Launcher ---
        var toolsLaunchSec = toolsContent.add("group");
        toolsLaunchSec.orientation = "column";
        toolsLaunchSec.alignChildren = "left";
        toolsLaunchSec.margins = 0;
        toolsLaunchSec.spacing = 2;

        var launchLabel = toolsLaunchSec.add("statictext", undefined, "Plugin & Script Launcher");
        // SAFE: Use try-catch for font styling; fallback to default if unavailable
        try {
            launchLabel.graphics.font = ScriptUI.newFont("Arial", "BOLD", 11);
        } catch (e) {
            // Fallback to system default font
        }

        var tRow2 = toolsLaunchSec.add("group");
        tRow2.orientation = "row";
        tRow2.spacing = 3;

        // Load saved tools from AE preferences
        var myFavs = [];
        if (app.settings.haveSetting("MyAEPanel", "FavTools")) {
            myFavs = app.settings.getSetting("MyAEPanel", "FavTools").split("||");
        } else {
            myFavs = ["Menu:Align", "Menu:Character"]; // Defaults
        }

        var ddLauncher = tRow2.add("dropdownlist", undefined, []);

        // Helper: Extract clean display name from stored value
        function getDisplayName(storedValue) {
            if (storedValue.indexOf("Menu:") === 0) {
                // For Menu: just return the plugin name
                return storedValue.substring(5);
            } else if (storedValue.indexOf("File:") === 0) {
                // For File: extract just the filename (no path)
                var filePath = storedValue.substring(5);
                var name = filePath.split("\\").pop(); // Get last part after backslash
                if (!name) name = filePath.split("/").pop(); // Fallback for forward slash
                return name || filePath;
            }
            return storedValue;
        }

        // Populate dropdown with clean display names, store full data
        for (var idx = 0; idx < myFavs.length; idx++) {
            var stored = myFavs[idx];
            if (!stored) continue;

            var displayName = getDisplayName(stored);
            var item = ddLauncher.add("item", displayName);
            // Store the full command/path in the item's data property
            item.data = stored;
        }

        if (ddLauncher.items.length > 0) ddLauncher.selection = 0;
        ddLauncher.preferredSize.width = 80;

        function saveLauncherSettings() {
            var arr = [];
            // Save only the .data values (full command/path), not display text
            for(var i=0; i<ddLauncher.items.length; i++) {
                arr.push(ddLauncher.items[i].data);
            }
            app.settings.saveSetting("MyAEPanel", "FavTools", arr.join("||"));
        }

        // Cache for menu command IDs to avoid rescanning every click
        var menuCommandCache = {};

        btn(tRow2, "▶", "Execute the selected tool/plugin from dropdown", function(){
            if (!ddLauncher.selection) return;
            // CRITICAL: Use .data (stored command) instead of .text (display name)
            var sel = ddLauncher.selection.data;
            app.beginUndoGroup("AE Panel - Launch");

            if (sel.indexOf("Menu:") === 0) {
                var cmd = sel.substring(5);
                // Strategy 1: findMenuCommandId (works for built-in menus)
                var id = app.findMenuCommandId(cmd);
                if (id && id !== 0) {
                    app.executeCommand(id);
                } else {
                    // Strategy 2: scan IDs to find plugin/panel commands exposed via Window menu
                    var found = false;
                    // Check cache first before scanning
                    if (menuCommandCache[cmd] !== undefined) {
                        app.executeCommand(menuCommandCache[cmd]);
                        found = true;
                    } else {
                        // Scan with reduced ceiling (5000 covers all known AE commands)
                        for (var scanId = 1; scanId <= 5000; scanId++) {
                            try {
                                var cmdName = app.menuCommandName(scanId);
                                if (cmdName && cmdName.toLowerCase().indexOf(cmd.toLowerCase()) !== -1) {
                                    menuCommandCache[cmd] = scanId;
                                    app.executeCommand(scanId);
                                    found = true;
                                    break;
                                }
                            } catch(e) {}
                        }
                    }
                    if (!found) {
                        alert("Could not find plugin or menu command: " + cmd + "\nMake sure the plugin is installed and AE is restarted.");
                    }
                }
            } else if (sel.indexOf("File:") === 0) {
                var f = new File(sel.substring(5));
                if (f.exists) $.evalFile(f);
                else alert("Could not find script file:\n" + f.fsName);
            }

            app.endUndoGroup();
        }, 24);

        btn(tRow2, "+", "Add menu plugin or script file to launcher", function(){
            var type = confirm("Click YES to add a Menu Plugin (e.g. 'Align', 'Duik').\nClick NO to browse for a Script File (.jsx).");
            if (type) {
                var cmd = prompt(
                    "Enter the plugin name exactly as it appears in AE's Window menu.\n" +
                    "Examples: 'Flow', 'Duik', 'Align', 'Motion Bro'",
                    "Flow"
                );
                if (cmd) {
                    var storedValue = "Menu:" + cmd;
                    // Add item with clean display name but store full data
                    var item = ddLauncher.add("item", cmd);
                    item.data = storedValue;
                    ddLauncher.selection = ddLauncher.items.length - 1;
                    saveLauncherSettings();
                }
            } else {
                var f = File.openDialog("Select a Script", "*.jsx;*.jsxbin");
                if (f) {
                    var storedValue = "File:" + f.fsName;
                    // Extract clean filename for display
                    var displayFileName = f.fsName.split("\\").pop();
                    if (!displayFileName) displayFileName = f.fsName.split("/").pop();
                    // Add item with clean filename but store full path
                    var item = ddLauncher.add("item", displayFileName);
                    item.data = storedValue;
                    ddLauncher.selection = ddLauncher.items.length - 1;
                    saveLauncherSettings();
                }
            }
        }, 24);

        btn(tRow2, "-", "Remove the selected tool from launcher", function(){
            if (ddLauncher.selection && ddLauncher.items.length > 0) {
                ddLauncher.remove(ddLauncher.selection);
                if(ddLauncher.items.length > 0) ddLauncher.selection = 0;
                saveLauncherSettings();
            }
        }, 24);

        win.layout.layout(true);
        return win;
    }

    var p = buildUI(thisObj);
    if (p instanceof Window) { p.center(); p.show(); }
}

    AE_Utility_Panel(thisObj);
}(this));