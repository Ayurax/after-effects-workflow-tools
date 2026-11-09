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
    // (removed non-essential debug output)
}

// ============================================================================
// PROGRESS BAR RESET HELPER
// ============================================================================
function resetProgressBar() {
    if (app && app.setProgressBar) {
        try {
            app.setProgressBar(0, 100);
        } catch (e) {}
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

            var scaleVal = layer.scale.value;
            var scaleX = scaleVal[0] / 100;
            var scaleY = scaleVal[1] / 100;
            var rot = (is3D ? 0 : layer.rotation.value) * Math.PI / 180;

            var compDeltaX = deltaX * scaleX * Math.cos(rot) - deltaY * scaleY * Math.sin(rot);
            var compDeltaY = deltaX * scaleX * Math.sin(rot) + deltaY * scaleY * Math.cos(rot);

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
                shiftKeyframes(posProp, compDeltaX, compDeltaY, 0, is3D);
            } else {
                posProp.setValue(is3D
                    ? [currentPosition[0] + compDeltaX, currentPosition[1] + compDeltaY, currentPosition[2]]
                    : [currentPosition[0] + compDeltaX, currentPosition[1] + compDeltaY]);
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
            try { app.refresh(); } catch(e) {}
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

    resetProgressBar();
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

        // IMPROVED: Simple and reliable bounds calculation using position, anchor, and scale
        for (var i = 0; i < sel.length; i++) {
            var layer = sel[i];
            if (!layer.enabled) continue;

            try {
                // Get layer position in comp space
                var pos = layer.position.value;
                var anchor = layer.anchorPoint.value;

                // Get source rect in layer local space
                var rect = layer.sourceRectAtTime(comp.time, false);
                if (!rect) continue;

                // Get scale values (as percentage, convert to ratio)
                var scaleVal = layer.scale.value;
                var scaleX = scaleVal[0] / 100;
                var scaleY = scaleVal[1] / 100;

                // Calculate actual bounds in comp space
                // accounting for anchor, position and scale
                var left   = pos[0] - (anchor[0] - rect.left)  * scaleX;
                var top    = pos[1] - (anchor[1] - rect.top)   * scaleY;
                var right  = left + rect.width  * scaleX;
                var bottom = top  + rect.height * scaleY;

                if (!isFinite(left) || !isFinite(top) ||
                    !isFinite(right) || !isFinite(bottom)) continue;

                if (left   < minX) minX = left;
                if (right  > maxX) maxX = right;
                if (top    < minY) minY = top;
                if (bottom > maxY) maxY = bottom;

                validLayersFound++;

            } catch(e) {
                $.writeln("Error on layer " + layer.name + ": " + e.message);
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

    } catch (e) {
        alert("Error cropping comp: " + e.message);
        $.writeln("Crop operation failed: " + e.message);
    } finally {
        app.endUndoGroup();

        resetProgressBar();
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
    selArray.sort(function(a, b) { return b.index - a.index; });

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

// Shift keyframes on a layer when rebasing it to the start of a trimmed precomp.
function shiftPropertyKeyframes(prop, timeOffset) {
    if (!prop) return;

    if (prop.propertyType === PropertyType.PROPERTY) {
        if (!prop.numKeys) return;

        var keys = [];
        for (var k = 1; k <= prop.numKeys; k++) {
            var key = {
                time: prop.keyTime(k) + timeOffset,
                value: prop.keyValue(k),
                inType: prop.keyInInterpolationType(k),
                outType: prop.keyOutInterpolationType(k)
            };
            try { key.inEase = prop.keyInTemporalEase(k); key.outEase = prop.keyOutTemporalEase(k); } catch (eEase) {}
            try { key.inTangent = prop.keyInSpatialTangent(k); key.outTangent = prop.keyOutSpatialTangent(k); } catch (eTangent) {}
            try { key.spatialContinuous = prop.keySpatialContinuous(k); key.spatialAutoBezier = prop.keySpatialAutoBezier(k); } catch (eSpatial) {}
            try { key.temporalContinuous = prop.keyTemporalContinuous(k); key.temporalAutoBezier = prop.keyTemporalAutoBezier(k); } catch (eTemporal) {}
            try { key.roving = prop.keyRoving(k); } catch (eRoving) {}
            keys.push(key);
        }

        for (var removeIndex = prop.numKeys; removeIndex >= 1; removeIndex--) prop.removeKey(removeIndex);
        for (var i = 0; i < keys.length; i++) {
            var newIndex = prop.addKey(keys[i].time);
            prop.setValueAtKey(newIndex, keys[i].value);
            prop.setInterpolationTypeAtKey(newIndex, keys[i].inType, keys[i].outType);
            try { prop.setTemporalEaseAtKey(newIndex, keys[i].inEase, keys[i].outEase); } catch (eSetEase) {}
            try { prop.setSpatialTangentsAtKey(newIndex, keys[i].inTangent, keys[i].outTangent); } catch (eSetTangent) {}
            try { prop.setSpatialContinuousAtKey(newIndex, keys[i].spatialContinuous); } catch (eSetSpatial) {}
            try { prop.setSpatialAutoBezierAtKey(newIndex, keys[i].spatialAutoBezier); } catch (eSetAutoSpatial) {}
            try { prop.setTemporalContinuousAtKey(newIndex, keys[i].temporalContinuous); } catch (eSetTemporal) {}
            try { prop.setTemporalAutoBezierAtKey(newIndex, keys[i].temporalAutoBezier); } catch (eSetAutoTemporal) {}
            try { prop.setRovingAtKey(newIndex, keys[i].roving); } catch (eSetRoving) {}
        }
        return;
    }

    for (var p = 1; p <= prop.numProperties; p++) {
        shiftPropertyKeyframes(prop.property(p), timeOffset);
    }
}

function fitPrecompToLayerSpan(precomp, layer, originalIn, originalOut, originalStart) {
    var span = originalOut - originalIn;
    if (!precomp || !layer || span <= 0) return;

    shiftPropertyKeyframes(layer, -originalIn);
    layer.startTime = originalStart - originalIn;
    layer.inPoint = 0;
    layer.outPoint = span;
    precomp.duration = span;
}

function askBeatMarkerOptions() {
    var dialog = new Window("dialog", "Beat Markers");
    dialog.orientation = "column";
    dialog.alignChildren = "fill";
    dialog.margins = 14;
    dialog.spacing = 9;

    dialog.add("statictext", undefined, "Detect strong audio peaks and add composition markers.");

    var thresholdRow = dialog.add("group");
    thresholdRow.orientation = "row";
    thresholdRow.alignChildren = ["left", "center"];
    thresholdRow.add("statictext", undefined, "Sensitivity (% of loudest peak)");
    var thresholdInput = thresholdRow.add("edittext", undefined, "50");
    thresholdInput.characters = 5;

    var spacingRow = dialog.add("group");
    spacingRow.orientation = "row";
    spacingRow.alignChildren = ["left", "center"];
    spacingRow.add("statictext", undefined, "Minimum spacing (seconds)");
    var spacingInput = spacingRow.add("edittext", undefined, "0.1");
    spacingInput.characters = 5;

    var note = dialog.add("statictext", undefined, "Analyzes enabled audio across its timeline span.");
    note.alignment = ["left", "center"];

    var buttons = dialog.add("group");
    buttons.orientation = "row";
    buttons.alignment = ["right", "center"];
    buttons.spacing = 6;
    buttons.add("button", undefined, "Cancel", { name: "cancel" });
    buttons.add("button", undefined, "Create Markers", { name: "ok" });

    if (dialog.show() !== 1) return null;

    var threshold = parseFloat(thresholdInput.text);
    var spacing = parseFloat(spacingInput.text);
    if (isNaN(threshold) || threshold < 1 || threshold > 100 || isNaN(spacing) || spacing < 0) {
        alert("Enter a sensitivity from 1 to 100 and a spacing of 0 or more seconds.");
        return null;
    }
    return { threshold: threshold / 100, minSpacing: spacing };
}

function addBeatMarkers(comp, options) {
    var originalWorkAreaStart = comp.workAreaStart;
    var originalWorkAreaDuration = comp.workAreaDuration;
    var originalLayerCount = comp.numLayers;
    var audioAmplitudeLayer = null;
    var markersCreated = 0;

    try {
        var hasSoloAudio = false;
        for (var i = 1; i <= comp.numLayers; i++) {
            var candidate = comp.layer(i);
            try {
                if (candidate.hasAudio && candidate.audioEnabled && candidate.solo) hasSoloAudio = true;
            } catch (eSolo) {}
        }

        var audioStart = comp.duration;
        var audioEnd = 0;
        var foundAudio = false;
        for (var i = 1; i <= comp.numLayers; i++) {
            var audioLayer = comp.layer(i);
            try {
                if (!audioLayer.hasAudio || !audioLayer.audioEnabled || (hasSoloAudio && !audioLayer.solo)) continue;
                audioStart = Math.min(audioStart, audioLayer.inPoint);
                audioEnd = Math.max(audioEnd, audioLayer.outPoint);
                foundAudio = true;
            } catch (eAudio) {}
        }

        if (!foundAudio) throw new Error("No enabled audio layers were found in this composition.");
        audioStart = Math.max(0, audioStart);
        audioEnd = Math.min(comp.duration, audioEnd);
        if (audioEnd <= audioStart) throw new Error("The audio layers do not overlap the composition duration.");

        comp.workAreaStart = audioStart;
        comp.workAreaDuration = audioEnd - audioStart;

        // The menu label is case-sensitive in ExtendScript: the UI command uses lowercase "to".
        var commandId = app.findMenuCommandId("Convert Audio to Keyframes");
        if (!commandId) commandId = app.findMenuCommandId("Convert Audio To Keyframes");
        // Legacy command ID used by After Effects 2021 and earlier localized builds.
        if (!commandId && parseFloat(app.version) < 22) commandId = 5014;
        if (!commandId) throw new Error("After Effects could not find the Convert Audio To Keyframes command.");
        app.executeCommand(commandId);

        if (comp.numLayers <= originalLayerCount) throw new Error("After Effects did not create an Audio Amplitude layer.");
        audioAmplitudeLayer = comp.layer(1);
        if (!audioAmplitudeLayer || audioAmplitudeLayer.name !== "Audio Amplitude") {
            audioAmplitudeLayer = null;
            for (var j = 1; j <= comp.numLayers; j++) {
                if (comp.layer(j).name === "Audio Amplitude") {
                    audioAmplitudeLayer = comp.layer(j);
                    break;
                }
            }
        }
        if (!audioAmplitudeLayer) throw new Error("Could not locate the generated Audio Amplitude layer.");

        var effects = audioAmplitudeLayer.property("ADBE Effect Parade");
        var amplitudeProperty = null;
        for (var e = 1; effects && e <= effects.numProperties; e++) {
            var effect = effects.property(e);
            if (effect.name === "Both Channels") {
                amplitudeProperty = effect.property("ADBE Slider Control-0001") || effect.property(1);
                break;
            }
        }
        if (!amplitudeProperty || amplitudeProperty.numKeys < 3) {
            throw new Error("Could not read the Both Channels audio keyframes.");
        }

        var samples = [];
        var maxValue = 0;
        for (var k = 1; k <= amplitudeProperty.numKeys; k++) {
            var value = amplitudeProperty.keyValue(k);
            samples.push({ time: amplitudeProperty.keyTime(k), value: value });
            if (value > maxValue) maxValue = value;
        }
        if (maxValue <= 0) throw new Error("No audio peaks were detected in the work area.");

        var thresholdValue = maxValue * options.threshold;
        var candidates = [];
        for (var s = 1; s < samples.length - 1; s++) {
            var before = samples[s - 1].value;
            var current = samples[s].value;
            var after = samples[s + 1].value;
            if (current >= thresholdValue && current >= before && current >= after && (current > before || current > after)) {
                candidates.push({ time: samples[s].time, value: current });
            }
        }

        candidates.sort(function (a, b) { return b.value - a.value; });
        var chosen = [];
        for (var c = 0; c < candidates.length; c++) {
            var farEnough = true;
            for (var chosenIndex = 0; chosenIndex < chosen.length; chosenIndex++) {
                if (Math.abs(candidates[c].time - chosen[chosenIndex].time) < options.minSpacing) {
                    farEnough = false;
                    break;
                }
            }
            if (farEnough) chosen.push(candidates[c]);
        }
        chosen.sort(function (a, b) { return a.time - b.time; });
        if (chosen.length === 0) throw new Error("No peaks met the sensitivity setting. Try lowering sensitivity.");

        var markerProperty = comp.markerProperty;
        for (var oldMarker = markerProperty.numKeys; oldMarker >= 1; oldMarker--) {
            var oldValue = markerProperty.keyValue(oldMarker);
            var oldComment = oldValue.comment;
            var oldParameters = oldValue.getParameters();
            var isBeatMarker = oldComment && oldComment.indexOf("AE Utility Beat ") === 0;
            for (var paramIndex = 0; oldParameters && paramIndex < oldParameters.length; paramIndex++) {
                if (oldParameters[paramIndex][0] === "AEUtilityBeatMarker") isBeatMarker = true;
            }
            if (isBeatMarker) markerProperty.removeKey(oldMarker);
        }

        for (var m = 0; m < chosen.length; m++) {
            var marker = new MarkerValue(String(m + 1));
            // Label 1 is red in After Effects; label 0 keeps the default white marker.
            try { marker.label = chosen[m].value >= maxValue * 0.65 ? 1 : 0; } catch (eMarkerLabel) {}
            marker.setParameters([["AEUtilityBeatMarker", "1"]]);
            var markerTime = chosen[m].time;
            for (var existing = 1; existing <= markerProperty.numKeys; existing++) {
                if (Math.abs(markerProperty.keyTime(existing) - markerTime) < comp.frameDuration * 0.01) {
                    markerTime += comp.frameDuration * 0.05;
                    break;
                }
            }
            markerProperty.setValueAtTime(markerTime, marker);
            markersCreated++;
        }
    } finally {
        if (audioAmplitudeLayer) {
            try { audioAmplitudeLayer.remove(); } catch (eRemoveAmplitude) {}
        }
        comp.workAreaStart = originalWorkAreaStart;
        comp.workAreaDuration = originalWorkAreaDuration;
    }
    return markersCreated;
}

// ============================================================================
// CHARACTER SEPARATION HELPER (CHARS)
// ============================================================================
/**
 * Separate a selected text layer into individual character layers.
 * Positions each character precisely to reconstruct the original text layout,
 * accounting for kerning, advance widths, font metrics, spaces, and justification.
 */
function separateTextToCharacters() {
    var comp = AE.requireComp();
    if (!comp) return;

    var sel = comp.selectedLayers;
    if (!sel || sel.length !== 1) {
        alert(sel && sel.length > 1 ? "Please select only one text layer." : "Please select a text layer.");
        return;
    }

    var origLayer = sel[0];
    var textProp = origLayer.property("ADBE Text Properties");
    textProp = textProp ? textProp.property("ADBE Text Document") : null;
    if (!textProp) {
        alert("Selected layer is not a text layer.");
        return;
    }

    var originalText = textProp.value.text;
    if (!originalText || originalText.length === 0) {
        alert("Selected text layer is empty.");
        return;
    }

    app.beginUndoGroup("AE Panel - Chars");
    var createdLayers = [];
    try {
        var textProps = origLayer.property("ADBE Text Properties");
        var animators = textProps.property("ADBE Text Animators");

        // Each duplicate keeps the complete text run so After Effects preserves
        // the font's kerning, ligatures, contextual forms, and glyph advances.
        // Text animators hide every character except the selected index.
        for (var i = 0; i < originalText.length; i++) {
            var ch = originalText.charAt(i);
            if (ch === " " || ch === "\t" || ch === "\r" || ch === "\n") continue;

            var charLayer = origLayer.duplicate();
            createdLayers.push(charLayer);
            charLayer.name = ch;

            var charTextProps = charLayer.property("ADBE Text Properties");
            var charAnimators = charTextProps.property("ADBE Text Animators");

            var hideAnimator = charAnimators.addProperty("ADBE Text Animator");
            hideAnimator.name = "Hide Other Characters";
            var hideAnimatorIndex = hideAnimator.propertyIndex;
            var selectors = hideAnimator.property("ADBE Text Selectors");
            var targetSelector = selectors.addProperty("ADBE Text Selector");
            var advanced = targetSelector.property("ADBE Text Range Advanced");
            advanced.property("ADBE Text Selector Mode").setValue(2); // Subtract
            advanced.property("ADBE Text Range Units").setValue(2); // Index
            targetSelector.property("ADBE Text Index Start").setValue(i);
            targetSelector.property("ADBE Text Index End").setValue(i + 1);
            advanced.property("ADBE Text Selector Smoothness").setValue(0);
            // Adding a selector invalidates references to indexed child groups.
            hideAnimator = charAnimators.property(hideAnimatorIndex);
            hideAnimator.property("ADBE Text Animator Properties")
                .addProperty("ADBE Text Opacity").setValue(0);

            charLayer.moveBefore(origLayer);
        }

        if (createdLayers.length === 0) {
            alert("No non-space characters to separate.");
            return;
        }
        origLayer.enabled = false;
    } catch (err) {
        for (var j = 0; j < createdLayers.length; j++) {
            try { createdLayers[j].remove(); } catch (eRemove) {}
        }
        alert("Chars error: " + err.message);
    } finally {
        app.endUndoGroup();
    }
}

// ============================================================================
// CAMERA WORLD TRANSFORM HELPER
// ============================================================================
/**
 * Get the camera's actual world-space position and orientation at comp.time.
 *
 * Uses AE's native toWorld() which automatically resolves the ENTIRE parent
 * hierarchy (no matter how many nested nulls) including animated position,
 * scale, rotation, and orientation on every ancestor.
 *
 * The forward vector is determined by sampling two camera-local points and
 * converting them to world space:
 *   [0, 0, 0]  → camera origin in world space
 *   [0, 0, 1]  → a point one unit behind the camera in world space
 *
 * In AE, camera space uses a left-handed, Z-positive convention where
 * positive Z points INTO the scene (i.e. the viewing direction). Therefore
 * [0,0,1] is one unit in front of the camera (into the scene), giving us
 * the correct forward direction.
 *
 * @param  {CameraLayer} cam  - The camera layer to evaluate
 * @returns {{ pos: number[], fwd: number[], up: number[], right: number[] }|null}
 *          World-space position, normalised forward, up, and right vectors,
 *          or null if the calculation fails.
 */
function getCameraWorldTransformAtTime(cam) {
    try {
        // Camera-local origin → world space  (this IS the camera's world position)
        var wOrigin = cam.toWorld([0, 0, 0]);

        // Camera-local [0,0,1] → world space  (forward into the scene)
        var wFwd    = cam.toWorld([0, 0, 1]);

        // Camera-local [0,1,0] → world space  (down in camera space → gives us up axis)
        var wDown   = cam.toWorld([0, 1, 0]);

        // Camera-local [1,0,0] → world space  (right axis)
        var wRight  = cam.toWorld([1, 0, 0]);

        // Build normalised direction vectors
        function vecSub(a, b) { return [a[0]-b[0], a[1]-b[1], a[2]-b[2]]; }
        function vecLen(v) { return Math.sqrt(v[0]*v[0] + v[1]*v[1] + v[2]*v[2]); }
        function vecNorm(v) {
            var l = vecLen(v);
            if (l < 0.000001) return [0, 0, 1];
            return [v[0]/l, v[1]/l, v[2]/l];
        }

        var fwd   = vecNorm(vecSub(wFwd,   wOrigin));
        var down  = vecNorm(vecSub(wDown,  wOrigin));
        var right = vecNorm(vecSub(wRight, wOrigin));

        // "Up" for text facing = opposite of camera's down axis
        var up = [-down[0], -down[1], -down[2]];

        return {
            pos:   [wOrigin[0], wOrigin[1], wOrigin[2]],
            fwd:   fwd,
            up:    up,
            right: right
        };
    } catch (e) {
        alert("getCameraWorldTransformAtTime CRASHED: " + e.message + " (line " + e.line + ")");
        return null;
    }
}

/**
 * Choose a safe distance in front of the camera.
 * We base it on the composition diagonal so the result scales naturally
 * with different comp sizes / camera setups.
 *
 * @param  {CompItem} comp
 * @param  {CameraLayer} cam
 * @returns {number}
 */
function getCameraPlacementDistance(comp, cam) {
    // Use camera zoom if available to get a distance that keeps text fully visible
    var dist = 1000; // sensible default
    try {
        var zoom = cam.property("ADBE Camera Options Group").property("ADBE Camera Zoom").value;
        // At this zoom, a sensor of comp-width fills the frame at distance = zoom.
        // Place text at zoom distance so it fills the view nicely.
        if (zoom > 0) dist = zoom;
    } catch (e) {}
    // Clamp so text is never too close (<100) or uselessly far (>10000)
    if (dist < 100)   dist = 100;
    if (dist > 10000) dist = 10000;
    return dist;
}

/**
 * Copy text-document styling and layer properties from a reference text layer
 * to a newly created text layer.
 *
 * ONLY copies styling — does NOT touch position/anchor/orientation of newLayer.
 *
 * @param {TextLayer} refLayer  - the reference (selected) text layer
 * @param {TextLayer} newLayer  - the new text layer to receive properties
 * @param {CompItem}  comp
 */
function copyTextLayerProperties(refLayer, newLayer, comp) {
    // ── Text document (font, size, fill, tracking, etc.) ──────────────────
    try {
        var refTextProp = refLayer.property("ADBE Text Properties")
                                  .property("ADBE Text Document");
        var newTextProp = newLayer.property("ADBE Text Properties")
                                  .property("ADBE Text Document");
        if (refTextProp && newTextProp) {
            var refDoc = refTextProp.value;   // TextDocument snapshot
            newTextProp.setValue(refDoc);     // applies font/size/fill/stroke etc.
        }
    } catch (e) {
        $.writeln("Text document copy failed: " + e.message);
    }

    // ── Layer-level properties ─────────────────────────────────────────────
    try { newLayer.threeDLayer  = refLayer.threeDLayer;  } catch (e) {}
    try { newLayer.motionBlur   = refLayer.motionBlur;   } catch (e) {}
    try { newLayer.blendingMode = refLayer.blendingMode; } catch (e) {}
    try { newLayer.label        = refLayer.label;        } catch (e) {}

    // Opacity (evaluate at current time so we get the instantaneous value)
    try {
        newLayer.opacity.setValue(refLayer.opacity.valueAtTime(comp.time, false));
    } catch (e) {
        try { newLayer.opacity.setValue(refLayer.opacity.value); } catch (e2) {}
    }

    // Scale (keep reference scale so font visually matches)
    try {
        var refScale = refLayer.scale.valueAtTime(comp.time, false);
        newLayer.scale.setValue(refScale);
    } catch (e) {}

    // ── Effects ────────────────────────────────────────────────────────────
    // IMPORTANT: Do NOT use srcFX.property(ef).copyToComp() here.
    // In AE's ExtendScript API, calling copyToComp() on a property that belongs
    // to a layer copies the ENTIRE OWNING LAYER into the comp — not just the
    // effect — which is exactly the duplication we must avoid.
    //
    // Safe approach: add each effect to newLayer by matchName, then copy
    // the individual property values across. This never touches srcLayer.
    try {
        var srcFX = refLayer.property("ADBE Effect Parade");
        var dstFX = newLayer.property("ADBE Effect Parade");
        if (srcFX && dstFX && srcFX.numProperties > 0) {
            for (var ef = 1; ef <= srcFX.numProperties; ef++) {
                try {
                    var srcEffect = srcFX.property(ef);
                    var matchName = srcEffect.matchName;
                    // Add the effect to the destination layer by its internal match name
                    var dstEffect = dstFX.addProperty(matchName);
                    if (dstEffect) {
                        // Copy each sub-property value (skip group containers)
                        for (var ep = 1; ep <= srcEffect.numProperties; ep++) {
                            try {
                                var srcEP = srcEffect.property(ep);
                                var dstEP = dstEffect.property(ep);
                                if (srcEP && dstEP &&
                                    srcEP.propertyValueType !== PropertyValueType.NO_VALUE &&
                                    srcEP.propertyValueType !== PropertyValueType.CUSTOM_VALUE) {
                                    dstEP.setValue(srcEP.valueAtTime(comp.time, false));
                                }
                            } catch (epErr) {}
                        }
                    }
                } catch (efc) {
                    $.writeln("Effect copy (item " + ef + ") failed: " + efc.message);
                }
            }
        }
    } catch (e) {
        $.writeln("Effect copy (text) failed: " + e.message);
    }

    // ── Layer Styles ───────────────────────────────────────────────────────
    try {
        var srcSt = refLayer.property("ADBE Layer Styles");
        var dstSt = newLayer.property("ADBE Layer Styles");
        if (srcSt && dstSt && srcSt.numProperties > 0) {
            for (var st = 1; st <= srcSt.numProperties; st++) {
                try {
                    var s = srcSt.property(st);
                    var d = dstSt.property(st);
                    if (s && d && s.enabled) {
                        d.enabled = true;
                        for (var sp = 1; sp <= s.numProperties; sp++) {
                            try {
                                var sp_s = s.property(sp);
                                var sp_d = d.property(sp);
                                if (sp_s && sp_d &&
                                    sp_s.propertyValueType !== PropertyValueType.NO_VALUE) {
                                    sp_d.setValue(sp_s.value);
                                }
                            } catch (spe) {}
                        }
                    }
                } catch (ste) {}
            }
        }
    } catch (e) {
        $.writeln("Layer style copy (text) failed: " + e.message);
    }

    // ── Text Animators ────────────────────────────────────────────────────
    // NOTE: Text animators cannot be transferred without copyToComp() in
    // ExtendScript, and copyToComp() duplicates the entire source layer.
    // We intentionally skip animator transfer to prevent duplication.
    // The text document (font, size, fill, tracking, etc.) is already
    // fully copied above via setValue(refDoc), which is the safe path.
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
        win.margins = 6;
        win.spacing = 0;

        var g = win.add("group");
        g.orientation = "column";
        g.alignChildren = "fill";
        g.margins = 2;
        g.spacing = 6;

        // ===== PANEL HEADER =====
        var titleGroup = g.add("group");
        titleGroup.orientation = "column";
        titleGroup.alignChildren = ["left", "center"];
        titleGroup.margins = [4, 2, 4, 4];
        titleGroup.spacing = 1;

        var titleText = titleGroup.add("statictext", undefined, "AE Utility");
        titleText.alignment = ["left", "center"];
        try {
            titleText.graphics.font = ScriptUI.newFont("Arial", "BOLD", 14);
        } catch(e) {}
        var subtitle = titleGroup.add("statictext", undefined, "Quick controls for your composition");
        subtitle.alignment = ["left", "center"];

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
            var b = group.add("button", undefined, label);
            var sz = width || 26;
            b.preferredSize = [sz, 24];
            b.minimumSize = [sz, 24];
            b.maximumSize = [sz, 24];
            b.helpTip = tip;
            b.onClick = fn;
            return b;
        }

        function addSection(title) {
            var section = g.add("panel", undefined, title);
            section.orientation = "column";
            section.alignChildren = "fill";
            section.margins = [7, 8, 7, 7];
            section.spacing = 4;

            var btnGroup = section.add("group");
            btnGroup.orientation = "row";
            btnGroup.alignment = ["center", "center"];
            btnGroup.alignChildren = ["center", "center"];
            btnGroup.margins = 0;
            btnGroup.spacing = 4;

            return { section: section, btnGroup: btnGroup };
        }

        // ===== CREATE LAYERS =====
        var createSec = addSection("Create Layers");

        var createRow = createSec.section.add("group");
        createRow.orientation = "row";
        createRow.alignment = ["center", "center"];
        createRow.alignChildren = ["center", "center"];
        createRow.margins = 0;
        createRow.spacing = 3;

        btn(createRow,"Null","Create a null object for parenting and control", function(){
            perSelection(function(c,l){
                var targetWorldPos = null;
                if (l) {
                    try { targetWorldPos = l.toWorld(l.anchorPoint.value); } catch (eWorldPos) {}
                }
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
                    // Keep each generated null's anchor centered even when it is
                    // inserted above an already-parented null.
                    try {
                        n.anchorPoint.setValue([n.width / 2, n.height / 2]);
                    } catch (eAnchorCenter) {}
                    try {
                        if (!targetWorldPos) throw new Error("Could not read layer world position");
                        n.position.setValue(l.threeDLayer ? [targetWorldPos[0], targetWorldPos[1], targetWorldPos[2]] : [targetWorldPos[0], targetWorldPos[1]]);
                    } catch (e) {
                        try { n.position.setValue(l.position.value); } catch (e2) {}
                    }
                    l.parent=n;
                }
            },true);
        }, 43);

        btn(createRow,"Adjustment","Create adjustment layer (white solid) for effects", function(){
            perSelection(function(c,l,i){
                var a = c.layers.addSolid([1,1,1], "Adj " + (i + 1), c.width, c.height, c.pixelAspect);
                a.adjustmentLayer = true;
                a.label = 11;
                if (l) {
                    var layerIn = Math.min(l.inPoint, l.outPoint);
                    var layerOut = Math.max(l.inPoint, l.outPoint);
                    // A new solid starts at comp time zero. Align its source start
                    // with the clip before applying that clip's visible time span.
                    a.startTime = layerIn;
                    a.inPoint = layerIn;
                    a.outPoint = layerOut;
                    a.moveBefore(l);
                }
            }, true);
        }, 76);

        btn(createRow, "Solid", "Create a new solid layer", function() {
            var c = AE.requireComp();
            if (!c) return;

            var selectedLayers = c.selectedLayers;
            var spanIn = c.duration;
            var spanOut = 0;
            var topLayer = null;
            for (var i = 0; i < selectedLayers.length; i++) {
                var layer = selectedLayers[i];
                spanIn = Math.min(spanIn, layer.inPoint);
                spanOut = Math.max(spanOut, layer.outPoint);
                if (!topLayer || layer.index < topLayer.index) topLayer = layer;
            }

            app.beginUndoGroup("AE Panel - Solid");
            try {
                var countBefore = c.numLayers;
                app.executeCommand(2038);
                if (c.numLayers > countBefore && topLayer && spanOut > spanIn) {
                    // AE can insert the solid below the selected layer. The
                    // newly created solid is selected when the settings dialog closes.
                    var newSelection = c.selectedLayers;
                    var solid = null;
                    for (var selectedIndex = 0; selectedIndex < newSelection.length && !solid; selectedIndex++) {
                        var selectedAfterDialog = newSelection[selectedIndex];
                        var wasAlreadySelected = false;
                        for (var originalIndex = 0; originalIndex < selectedLayers.length; originalIndex++) {
                            var originalLayer = selectedLayers[originalIndex];
                            if (selectedAfterDialog === originalLayer ||
                                (selectedAfterDialog.id !== undefined && originalLayer.id !== undefined && selectedAfterDialog.id === originalLayer.id)) {
                                wasAlreadySelected = true;
                                break;
                            }
                        }
                        if (!wasAlreadySelected) solid = selectedAfterDialog;
                    }
                    if (!solid) {
                        for (var layerIndex = 1; layerIndex <= c.numLayers; layerIndex++) {
                            var candidate = c.layer(layerIndex);
                            if (candidate.name !== topLayer.name && candidate.source && candidate.source.mainSource instanceof SolidSource) {
                                solid = candidate;
                                break;
                            }
                        }
                    }
                    if (!solid) throw new Error("Could not locate the new solid layer.");
                    solid.startTime = spanIn;
                    solid.inPoint = spanIn;
                    solid.outPoint = spanOut;
                    solid.moveBefore(topLayer);
                }
            } finally {
                app.endUndoGroup();
            }
        }, 43);

        btn(createRow, "Text", "Create a centered text layer", function () {
            var c = AE.requireComp();
            if (!c) return;

            var selectedLayers = c.selectedLayers;
            var spanIn = c.duration;
            var spanOut = 0;
            var topLayer = null;
            for (var i = 0; i < selectedLayers.length; i++) {
                var layer = selectedLayers[i];
                spanIn = Math.min(spanIn, layer.inPoint);
                spanOut = Math.max(spanOut, layer.outPoint);
                if (!topLayer || layer.index < topLayer.index) topLayer = layer;
            }

            app.beginUndoGroup("Create Text Layer");
            try {
                var t = c.layers.addText("Text 1");
                var textDocProp = t.property("ADBE Text Properties").property("ADBE Text Document");
                var textDoc = textDocProp.value;
                textDoc.justification = ParagraphJustification.CENTER_JUSTIFY;
                textDocProp.setValue(textDoc);

                var rect = t.sourceRectAtTime(c.time, false);
                t.anchorPoint.setValue([rect.left + rect.width / 2, rect.top + rect.height / 2]);
                t.position.setValue([c.width / 2, c.height / 2]);
                if (topLayer && spanOut > spanIn) {
                    t.startTime = spanIn;
                    t.inPoint = spanIn;
                    t.outPoint = spanOut;
                    t.moveBefore(topLayer);
                }
            } finally {
                app.endUndoGroup();
            }
        }, 43);

        var createRow2 = createSec.section.add("group");
        createRow2.orientation = "row";
        createRow2.alignment = ["center", "center"];
        createRow2.alignChildren = ["center", "center"];
        createRow2.margins = 0;
        createRow2.spacing = 3;

        btn(createRow2, "Split Text", "Separate text into individual character layers", function () {
            separateTextToCharacters();
        }, 96);

        // ===== TIMING =====
        var timingSec = addSection("Timing");

        var utilRow2 = timingSec.section.add("group");
        utilRow2.orientation = "row";
        utilRow2.alignment = ["center", "center"];
        utilRow2.alignChildren = ["center", "center"];
        utilRow2.margins = 0;
        utilRow2.spacing = 4;

        btn(utilRow2, "1 Frame", "Create single-frame adjustment layer at playhead", function(){
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
        }, 96);

        btn(utilRow2, "Quick Trim", "Trim selected layers to 2 seconds centered on playhead (1 sec each side)", function(){
            var c = AE.requireComp();
            if (!c) return;

            var sel = c.selectedLayers;
            if (sel.length === 0) {
                alert("Select at least one layer");
                return;
            }

            var playhead = c.time;
            var trimIn = playhead - 1;
            var trimOut = playhead + 1;

            app.beginUndoGroup("AE Panel - 2S Trim");

            var shortLayers = [];

            for (var i = 0; i < sel.length; i++) {
                var layer = sel[i];

                try {
                    var layerDuration = layer.outPoint - layer.inPoint;

                    if (layerDuration < 2) {
                        shortLayers.push(layer.name);
                        continue;
                    }

                    var adjustedTrimIn = trimIn;
                    var adjustedTrimOut = trimOut;

                    if (adjustedTrimIn < layer.inPoint) {
                        adjustedTrimIn = layer.inPoint;
                    }
                    if (adjustedTrimOut > layer.outPoint) {
                        adjustedTrimOut = layer.outPoint;
                    }

                    layer.inPoint = adjustedTrimIn;
                    layer.outPoint = adjustedTrimOut;

                } catch (layerError) {
                    $.writeln("Error trimming layer '" + layer.name + "': " + layerError.message);
                }
            }

            app.endUndoGroup();

            if (shortLayers.length > 0) {
                alert("These layers are shorter than 2 seconds and were skipped:\n" + shortLayers.join("\n"));
            }
        }, 96);

        var beatRow = timingSec.section.add("group");
        beatRow.orientation = "row";
        beatRow.alignment = ["center", "center"];
        beatRow.alignChildren = ["center", "center"];
        beatRow.margins = 0;
        beatRow.spacing = 4;
        btn(beatRow, "Beat Markers", "Analyze enabled audio and add markers at strong rhythmic peaks", function(){
            var comp = AE.requireComp();
            if (!comp) return;
            var options = askBeatMarkerOptions();
            if (!options) return;

            app.beginUndoGroup("AE Panel - Beat Markers");
            try {
                var count = addBeatMarkers(comp, options);
                alert("Created " + count + " beat markers.");
            } catch (err) {
                alert("Beat marker error: " + err.message);
            } finally {
                app.endUndoGroup();
            }
        }, 196);

        // ===== EFFECTS =====
        var effectsSec = addSection("Effects");

        var twixtorSec = effectsSec.section.add("group");
        twixtorSec.orientation = "column";
        twixtorSec.alignment = ["center", "center"];
        twixtorSec.alignChildren = ["center", "center"];
        twixtorSec.margins = 0;
        twixtorSec.spacing = 4;

        var twixtorHeaderBtn = twixtorSec.add("button", undefined, "Twixtor ▼", { style: "toolbutton" });
        twixtorHeaderBtn.alignment = ["center", "center"];
        twixtorHeaderBtn.preferredSize = [196, 20];
        twixtorHeaderBtn.minimumSize = [196, 20];
        twixtorHeaderBtn.maximumSize = [196, 20];
        twixtorHeaderBtn.helpTip = "Twixtor helper tools";

        var twixtorContent = twixtorSec.add("group");
        twixtorContent.orientation = "column";
        twixtorContent.alignment = ["center", "center"];
        twixtorContent.alignChildren = ["center", "center"];
        twixtorContent.margins = 0;
        twixtorContent.spacing = 2;
        twixtorContent.visible = false;
        twixtorContent.maximumSize = [9999, 0];

        var isTwixtorExpanded = false;

        twixtorHeaderBtn.onClick = function() {
            isTwixtorExpanded = !isTwixtorExpanded;
            twixtorContent.visible = isTwixtorExpanded;
            twixtorContent.maximumSize = isTwixtorExpanded ? [9999, 9999] : [9999, 0];
            twixtorHeaderBtn.text = isTwixtorExpanded ? "Twixtor ▲" : "Twixtor ▼";
            win.layout.layout(true);
        };

        // Align Keys button
        var twixtorRow = twixtorContent.add("group");
        twixtorRow.orientation = "row";
        twixtorRow.alignment = ["center", "center"];
        twixtorRow.alignChildren = ["center", "center"];
        twixtorRow.margins = 0;
        twixtorRow.spacing = 4;

        btn(twixtorRow, "Align Keys", "Snap selected keyframes to first key (1-frame spacing)", function(){
            var c=getComp(); if(!c) return;
            var sel=c.selectedLayers;
            if(sel.length===0) return;

            app.beginUndoGroup("AE Panel - Align Keys");

            var frameDuration = 1 / c.frameRate;

            for(var i=0;i<sel.length;i++){
                var layer = sel[i];

                // UI REFRESH: Update progress and refresh UI every layer
                updateProgress(i + 1, sel.length, "Aligning Time Remap");
                if (i % 3 === 0) {
                    try { app.refresh(); } catch(e) {}
                }

                try {
                    // Get Time Remap property
                    var timeRemap = layer.property("ADBE Time Remapping");
                    if (!timeRemap) continue;

                    // Get all selected keyframes EXCEPT the last one
                    var selectedKeys = [];
                    var totalKeys = timeRemap.numKeys;
                    for (var k = 1; k <= totalKeys - 1; k++) {
                        if (timeRemap.keySelected(k)) {
                            selectedKeys.push({
                                index: k,
                                time: timeRemap.keyTime(k),
                                value: timeRemap.keyValue(k)
                            });
                        }
                    }

                    // Skip if less than 2 keys selected
                    if (selectedKeys.length < 2) continue;

                    // Keep first selected key's time as anchor
                    var startTime = selectedKeys[0].time;

                    // Cache all values first
                    var values = [];
                    for (var m = 0; m < selectedKeys.length; m++) {
                        values.push(selectedKeys[m].value);
                    }

                    // Remove in reverse order to avoid index shifting
                    for (var m = selectedKeys.length - 1; m >= 0; m--) {
                        timeRemap.removeKey(selectedKeys[m].index);
                    }

                    // Reapply at consecutive 1-frame intervals
                    for (var m = 0; m < values.length; m++) {
                        timeRemap.setValueAtTime(
                            startTime + (m * frameDuration),
                            values[m]
                        );
                    }

                } catch (layerError) {
                    $.writeln("Error aligning Time Remap on '" + layer.name + "': " + layerError.message);
                }
            }

            app.endUndoGroup();

            resetProgressBar();
        }, 96);

        btn(twixtorRow, "Sequence", "Arrange selected layers end-to-end (no gaps)", sequenceSelectedLayers, 96);

        // ===== ANCHOR =====
        var anchorSec = g.add("group");
        anchorSec.orientation = "column";
        anchorSec.alignment = ["center", "center"];
        anchorSec.alignChildren = ["center", "center"];
        anchorSec.margins = 0;
        anchorSec.spacing = 4;

        var anchorHeaderBtn = anchorSec.add("button", undefined, "Anchor +", { style: "toolbutton" });
        anchorHeaderBtn.alignment = ["center", "center"];
        anchorHeaderBtn.preferredSize = [196, 20];
        anchorHeaderBtn.minimumSize = [196, 20];
        anchorHeaderBtn.maximumSize = [196, 20];
        anchorHeaderBtn.helpTip = "Show or hide anchor point presets";

        var anchorContent = anchorSec.add("group");
        anchorContent.orientation = "column";
        anchorContent.alignment = ["center", "center"];
        anchorContent.alignChildren = ["center", "center"];
        anchorContent.margins = 0;
        anchorContent.spacing = 2;
        anchorContent.visible = false;
        anchorContent.maximumSize = [9999, 0];

        var isAnchorExpanded = false;
        anchorHeaderBtn.onClick = function() {
            isAnchorExpanded = !isAnchorExpanded;
            anchorContent.visible = isAnchorExpanded;
            anchorContent.maximumSize = isAnchorExpanded ? [9999, 9999] : [9999, 0];
            anchorHeaderBtn.text = isAnchorExpanded ? "Anchor -" : "Anchor +";
            win.layout.layout(true);
        };

        // 3x3 Anchor Preset Grid
        var presets = [["TL", "TC", "TR"], ["CL", "CC", "CR"], ["BL", "BC", "BR"]];

        for (var row = 0; row < 3; row++) {
            var rowGroup = anchorContent.add("group");
            rowGroup.orientation = "row";
            rowGroup.alignment = ["center", "center"];
            rowGroup.alignChildren = ["center", "center"];
            rowGroup.margins = 0;
            rowGroup.spacing = 2;

            for (var col = 0; col < 3; col++) {
                var label = presets[row][col];
                var b = rowGroup.add("button", undefined, label);
                b.preferredSize = [27, 23];
                b.minimumSize = [27, 23];
                b.maximumSize = [27, 23];

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
                        var actualMode = (presetMode === "CC") ? "C" : presetMode;
                        setAnchorPreset(actualMode, savedLayerIndices);
                        app.endUndoGroup();
                    };
                })(label);
            }
        }

        // ===== COMPOSITION =====
        var toolsSec = addSection("Composition");

        var tRow1 = toolsSec.section.add("group");
        tRow1.orientation = "row";
        tRow1.alignment = ["center", "center"];
        tRow1.alignChildren = ["center", "center"];
        tRow1.margins = 0;
        tRow1.spacing = 4;
        btn(tRow1, "Unpack", "Decompose precomp into parent composition (preserves keyframes & effects)", decomposeSelectedPrecomps_Advanced, 62);

        btn(tRow1, "Isolate", "Precompose each selected layer individually", function(){
            var comp = AE.requireComp();
            if (!comp) return;

            var selectedLayers = AE.requireSelection(comp);
            if (!selectedLayers) return;

            var optionsDialog = new Window("dialog", "Isolate Layers");
            optionsDialog.orientation = "column";
            optionsDialog.alignChildren = "fill";
            optionsDialog.margins = 14;
            optionsDialog.spacing = 10;
            optionsDialog.add("statictext", undefined, "Choose the duration for each new precomp:");
            var adjustDuration = optionsDialog.add("checkbox", undefined, "Adjust composition duration to the selected layer span");
            adjustDuration.value = false;

            var optionsButtons = optionsDialog.add("group");
            optionsButtons.orientation = "row";
            optionsButtons.alignment = ["right", "center"];
            optionsButtons.spacing = 6;
            optionsButtons.add("button", undefined, "Cancel", { name: "cancel" });
            optionsButtons.add("button", undefined, "Isolate", { name: "ok" });

            if (optionsDialog.show() !== 1) return;

            app.beginUndoGroup("AE Panel - Precompose");

            var layerData = [];
            for (var i = 0; i < selectedLayers.length; i++) {
                var layer = selectedLayers[i];
                layerData.push({
                    index: layer.index,
                    startTime: layer.startTime,
                    inPoint: layer.inPoint,
                    outPoint: layer.outPoint,
                    name: layer.name
                });
            }

            layerData.sort(function (a, b) { return b.index - a.index; });

            for (var i = 0; i < layerData.length; i++) {
                var data = layerData[i];
                var precomp = comp.layers.precompose([data.index], "PreComp " + (i + 1), true);
                var newLayer = comp.layer(data.index);
                if (newLayer) {
                    if (adjustDuration.value) {
                        fitPrecompToLayerSpan(precomp, precomp.layer(1), data.inPoint, data.outPoint, data.startTime);
                        newLayer.startTime = data.inPoint;
                    }
                    newLayer.inPoint = data.inPoint;
                    newLayer.outPoint = data.outPoint;
                }
            }

            app.endUndoGroup();
        }, 64);

        btn(tRow1, "Fit Comp", "Crop composition to layer bounds (supports rotation & scale)", cropCompToSelection, 62);

        var cacheRow = toolsSec.section.add("group");
        cacheRow.orientation = "row";
        cacheRow.alignment = ["center", "center"];
        cacheRow.alignChildren = ["center", "center"];
        cacheRow.margins = 0;
        cacheRow.spacing = 4;
        btn(cacheRow, "Purge Cache", "Clear After Effects memory and disk caches", function(){
            try {
                var versionParts = String(app.version).split(".");
                var majorVersion = parseInt(versionParts[0], 10);
                var minorVersion = parseInt(versionParts[1], 10);
                if (majorVersion > 24 || (majorVersion === 24 && minorVersion >= 3)) {
                    app.purge(PurgeTarget.ALL_CACHES);
                } else {
                    // Before AE 24.3, ALL_CACHES only purges RAM. Use AE's full
                    // All Memory & Disk Cache command so the preview cache clears too.
                    var purgeCommand = app.findMenuCommandId("All Memory & Disk Cache...");
                    app.executeCommand(purgeCommand || 10200);
                }
            } catch (err) {
                alert("Cache purge error: " + err.message);
            }
        }, 196);

        win.layout.layout(true);
        return win;
    }

    var p = buildUI(thisObj);
    if (p instanceof Window) { p.center(); p.show(); }
}

    AE_Utility_Panel(thisObj);
}(this));

