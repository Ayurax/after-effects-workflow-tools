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
// BEAT DEBUG LOG HELPER
// ============================================================================
function beatLog(msg) {
    try {
        var f = new File(Folder.temp.fsName + "/beat_debug.log");
        var opened = f.open("a");
        if (!opened) {
            alert("beatLog: FAILED TO OPEN FILE. path=" + f.fsName);
            return;
        }
        f.writeln(new Date().toString() + " - " + msg);
        f.close();
    } catch (e) {
        alert("beatLog CRASHED: " + e.message + " (line " + e.line + ")");
    }
}

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
// BEAT DETECTION HELPERS
// ============================================================================

var lastAudioSourceDiag = null;

function getPythonCommand() {
    var pythonCmd = "python";
    try {
        var settingsFile = new File(File($.fileName).parent.fsName + "/beat_settings.json");
        $.writeln("Beat Detect: Checking settings file: " + settingsFile.fsName + " (exists: " + settingsFile.exists + ")");
        if (settingsFile.exists) {
            var content = settingsFile.open("r") ? settingsFile.read() : "";
            settingsFile.close();
            if (content) {
                var settings = JSON.parse(content);
                if (settings && settings.pythonCmd) {
                    pythonCmd = settings.pythonCmd;
                    $.writeln("Beat Detect: Using configured Python: " + pythonCmd);
                }
            }
        }
    } catch (e) {
        $.writeln("Beat Detect: Error reading settings: " + e.message);
    }
    $.writeln("Beat Detect: Final Python command: " + pythonCmd);
    return pythonCmd;
}

function savePythonCommand(cmd) {
    try {
        var settingsFile = new File(File($.fileName).parent.fsName + "/beat_settings.json");
        settingsFile.open("w");
        settingsFile.write(JSON.stringify({ pythonCmd: cmd }));
        settingsFile.close();
    } catch (e) {}
}

function getAnalyzerScriptPath() {
    var scriptFile = new File(File($.fileName).parent.fsName + "/audio_beat_detector.py");
    return scriptFile;
}

function isAudioLayer(layer) {
    try {
        if (!layer) return false;

        var audioChannel = null;

        try {
            audioChannel = layer.audio;
        } catch (e1) {
            $.writeln("Beat Detect: layer.audio access failed: " + e1.message);
            return false;
        }

        if (!audioChannel) {
            $.writeln("Beat Detect: layer has no audio channel");
            return false;
        }

        try {
            return audioChannel.enabled === true;
        } catch (e2) {
            $.writeln("Beat Detect: audio.enabled access failed: " + e2.message);
            return false;
        }

    } catch (e) {
        $.writeln("Beat Detect: isAudioLayer failed: " + e.message);
        return false;
    }
}

function getLayerSourceAudioPath(layer) {
    lastAudioSourceDiag = null;
    try {
        var source = layer.source;
        $.writeln("Beat Detect: Layer source: " + (source ? source.name : "null"));

        lastAudioSourceDiag = {
            layerName: layer.name,
            sourceType: source ? (source instanceof CompItem ? "CompItem" : (source instanceof FootageItem ? "FootageItem" : typeof source)) : "null",
            sourceName: source ? source.name : "no source",
            mainSource: source && source.mainSource ? source.mainSource.toString() : "no mainSource",
            sourceFile: source && source.file ? source.file.fsName : "no source.file",
            sourceFileExists: source && source.file ? source.file.exists : "n/a",
            mainSourceFile: source && source.mainSource && source.mainSource.file ? source.mainSource.file.fsName : "no mainSource.file",
            mainSourceFileExists: source && source.mainSource && source.mainSource.file ? source.mainSource.file.exists : "n/a"
        };

        if (source && source.file && source.file.exists) {
            $.writeln("Beat Detect: Found source file: " + source.file.fsName);
            return source.file.fsName;
        }
        if (source && source.mainSource && source.mainSource.file && source.mainSource.file.exists) {
            $.writeln("Beat Detect: Found mainSource file: " + source.mainSource.file.fsName);
            return source.mainSource.file.fsName;
        }
        $.writeln("Beat Detect: No source file found");
    } catch (e) {
        $.writeln("Beat Detect: Error getting source path: " + e.message);
        lastAudioSourceDiag = { error: e.message };
    }
    return null;
}

function renderLayerAudioToWav(layer, comp, wavPath) {
    $.writeln("Beat Detect: Starting WAV render to " + wavPath);
    
    var rqItem = app.project.renderQueue.items.add(comp);
    $.writeln("Beat Detect: Added render queue item");
    
    rqItem.applyTemplate("Audio Only");
    
    var hasAudioTemplate = false;
    try {
        var templates = app.project.renderQueue.templates;
        for (var i = 1; i <= templates.length; i++) {
            if (templates[i].name === "Audio Only") {
                hasAudioTemplate = true;
                break;
            }
        }
    } catch (e) {
        $.writeln("Beat Detect: Template check failed: " + e.message);
    }
    
    if (!hasAudioTemplate) {
        $.writeln("Beat Detect: No Audio Only template, configuring output module manually");
        var om = rqItem.outputModules[1];
        om.applyTemplate("WAV");
        var omSettings = om.getSettings();
        omSettings.audioEnabled = true;
        omSettings.videoEnabled = false;
        om.setSettings(omSettings);
    }
    
    var rs = rqItem.renderSettings;
    rs.startTime = layer.inPoint;
    rs.endTime = layer.outPoint;
    rqItem.renderSettings = rs;
    $.writeln("Beat Detect: Render settings set - start: " + layer.inPoint + ", end: " + layer.outPoint);
    
    var om = rqItem.outputModules[1];
    om.file = new File(wavPath);
    
    var renderSuccess = false;
    try {
        $.writeln("Beat Detect: Calling renderQueue.render()...");
        app.project.renderQueue.render();
        $.writeln("Beat Detect: renderQueue.render() returned");
        
        // Wait for render to complete by checking file
        var wavFile = new File(wavPath);
        var waitCount = 0;
        while (!wavFile.exists && waitCount < 600) { // up to 60 seconds
            $.sleep(100);
            waitCount++;
        }
        
        if (wavFile.exists) {
            renderSuccess = true;
            $.writeln("Beat Detect: WAV file created successfully: " + wavPath + " (size: " + wavFile.length + ")");
        } else {
            $.writeln("Beat Detect: ERROR - WAV file was not created after waiting");
            renderSuccess = false;
        }
    } catch (e) {
        $.writeln("Beat Detect: Render exception: " + e.message);
        renderSuccess = false;
    }
    
    rqItem.remove();
    return renderSuccess;
}

function exportAudioForAnalysis(layer, comp) {
    $.writeln("Beat Detect: Preparing audio for analysis...");
    $.writeln("Beat Detect: About to call getLayerSourceAudioPath()");
    var sourcePath = getLayerSourceAudioPath(layer);
    $.writeln("Beat Detect: getLayerSourceAudioPath() returned: " + (sourcePath ? sourcePath : "null"));
    if (sourcePath) {
        $.writeln("Beat Detect: Using source audio file directly: " + sourcePath);
        return sourcePath;
    }
    
    $.writeln("Beat Detect: No direct file-backed audio source found for this layer; render-queue fallback is disabled because it can hang the AE UI thread.");
    return null;
}

function runBeatAnalyzer(audioPath, sensitivity, minGap, progressWin) {
    beatLog("runBeatAnalyzer: started");
    var base = File($.fileName).parent.fsName;
    var stamp = (new Date()).getTime();

    var pythonCmd  = getPythonCommand();
    beatLog("getPythonCommand returned: " + pythonCmd);
    var scriptPath = getAnalyzerScriptPath();
    beatLog("getAnalyzerScriptPath returned: " + scriptPath.fsName + " exists=" + scriptPath.exists);
    var jsonPath   = new File(base + "/temp_beat_result_" + stamp + ".json");
    var outLog     = new File(base + "/temp_beat_stdout_" + stamp + ".txt");
    var errLog     = new File(base + "/temp_beat_stderr_" + stamp + ".txt");
    var exitFile   = new File(base + "/temp_beat_exit_" + stamp + ".txt");
    var doneFile   = new File(base + "/temp_beat_done_" + stamp + ".flag");
    var ps1Path    = new File(base + "/temp_beat_launcher_" + stamp + ".ps1");

    function psQuote(s) { return "'" + String(s).replace(/'/g, "''") + "'"; }

    var pyArgs = [
        psQuote(scriptPath.fsName),
        psQuote(audioPath),
        "--sensitivity", sensitivity,
        "--min-gap", minGap,
        "--json", psQuote(jsonPath.fsName)
    ].join(" ");

    var ps1 =
        '$ErrorActionPreference = "Continue"\r\n' +
        '$psi = New-Object System.Diagnostics.ProcessStartInfo\r\n' +
        '$psi.FileName = ' + psQuote(pythonCmd) + '\r\n' +
        '$psi.Arguments = ' + psQuote(pyArgs) + '\r\n' +
        '$psi.UseShellExecute = $false\r\n' +
        '$psi.RedirectStandardOutput = $true\r\n' +
        '$psi.RedirectStandardError = $true\r\n' +
        '$psi.CreateNoWindow = $true\r\n' +
        '$proc = [System.Diagnostics.Process]::Start($psi)\r\n' +
        '$stdout = $proc.StandardOutput.ReadToEnd()\r\n' +
        '$stderr = $proc.StandardError.ReadToEnd()\r\n' +
        '$proc.WaitForExit()\r\n' +
        'Set-Content -Path ' + psQuote(outLog.fsName) + ' -Value $stdout\r\n' +
        'Set-Content -Path ' + psQuote(errLog.fsName) + ' -Value $stderr\r\n' +
        'Set-Content -Path ' + psQuote(exitFile.fsName) + ' -Value $proc.ExitCode\r\n' +
        'Set-Content -Path ' + psQuote(doneFile.fsName) + ' -Value "1"\r\n';

    beatLog("ps1 string built, length=" + ps1.length);
    ps1Path.open("w"); ps1Path.write(ps1); ps1Path.close();
    beatLog("ps1 file written");

    $.writeln("Beat Detect: Python exe: " + pythonCmd);
    $.writeln("Beat Detect: Analyzer script: " + scriptPath.fsName);
    $.writeln("Beat Detect: Audio input: " + audioPath);
    $.writeln("Beat Detect: Output JSON: " + jsonPath.fsName);

    var launchCmd = 'powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + ps1Path.fsName + '"';
    beatLog("Launching: " + launchCmd);

    var detachedCmd = 'cmd.exe /c start "" /min ' + launchCmd;
    system.callSystem(detachedCmd);
    beatLog("callSystem launch issued");

    var launched = true;

    var TIMEOUT_MS = 120000, POLL_MS = 100, elapsed = 0;
    beatLog("Entering polling loop");
    while (elapsed < TIMEOUT_MS && !doneFile.exists) {
        if (progressWin && progressWin.cancelled) {
            $.writeln("Beat Detect: Cancelled by user during polling");
            break;
        }
        $.sleep(POLL_MS);
        elapsed += POLL_MS;
        if (progressWin && elapsed % 1000 < POLL_MS) {
            try {
                var pct = Math.min(90, 50 + Math.floor((elapsed / TIMEOUT_MS) * 40));
                progressWin.children[1].value = pct;
                progressWin.children[0].text = "Analyzing audio... " + pct + "%";
                progressWin.update();
            } catch (e) {}
        }
    }
    beatLog("Exited polling loop. elapsed=" + elapsed + " doneFile.exists=" + doneFile.exists + " cancelled=" + (progressWin && progressWin.cancelled));

    if (progressWin && progressWin.cancelled) {
        // Clean up partial files
        var filesToRemove = [ps1Path, jsonPath, outLog, errLog, exitFile, doneFile];
        for (var fi = 0; fi < filesToRemove.length; fi++) {
            try {
                if (filesToRemove[fi].exists) filesToRemove[fi].remove();
            } catch (e) {}
        }
        return { success: false, error: "Cancelled by user." };
    }

    function readAndRemove(f) {
        if (!f.exists) return "";
        f.open("r"); var c = f.read(); f.close(); f.remove();
        return c;
    }

    var stdoutTxt = readAndRemove(outLog);
    var stderrTxt = readAndRemove(errLog);
    var exitTxt   = readAndRemove(exitFile);
    var timedOut  = !doneFile.exists;
    if (doneFile.exists) doneFile.remove();
    if (ps1Path.exists) ps1Path.remove();

    $.writeln("Beat Detect: timedOut=" + timedOut + " exitCode=" + exitTxt);
    if (stderrTxt) $.writeln("Beat Detect: stderr:\n" + stderrTxt);

    if (timedOut) {
        return { success: false, error: "Analyzer timed out after " + (TIMEOUT_MS/1000) + "s.",
                 diag: { pythonCmd: pythonCmd, script: scriptPath.fsName, audio: audioPath,
                         ps1Path: ps1Path.fsName, exitCode: null, stderr: stderrTxt } };
    }

    if (String(exitTxt).replace(/\s/g, "") !== "0") {
        return { success: false, error: "Python exited with code " + exitTxt + ". " + (stderrTxt || "(no stderr)"),
                 diag: { pythonCmd: pythonCmd, script: scriptPath.fsName, audio: audioPath,
                         ps1Path: ps1Path.fsName, exitCode: exitTxt, stderr: stderrTxt } };
    }

    if (!jsonPath.exists || jsonPath.length === 0) {
        return { success: false, error: "Python exited 0 but wrote no JSON. stdout: " + stdoutTxt,
                 diag: { pythonCmd: pythonCmd, script: scriptPath.fsName, audio: audioPath,
                         ps1Path: ps1Path.fsName, exitCode: exitTxt, stderr: stderrTxt } };
    }

    jsonPath.open("r"); var content = jsonPath.read(); jsonPath.close(); jsonPath.remove();
    try {
        return JSON.parse(content);
    } catch (e) {
        return { success: false, error: "JSON parse failed: " + e.message,
                 diag: { pythonCmd: pythonCmd, script: scriptPath.fsName, audio: audioPath, ps1Path: ps1Path.fsName } };
    }
}

function clearPreviousBeatMarkers(layer) {
    var markerProp = layer.property("ADBE Marker");
    if (!markerProp) return;
    var toRemove = [];
    for (var i = 1; i <= markerProp.numKeys; i++) {
        var marker = markerProp.keyValue(i);
        if (marker && (marker.comment === "BASS" || marker.comment === "TREBLE" || marker.comment === "BEAT_BASS" || marker.comment === "BEAT_TREBLE")) {
            toRemove.push(i);
        }
    }
    for (var j = toRemove.length - 1; j >= 0; j--) {
        markerProp.removeKey(toRemove[j]);
    }
}

function createBeatMarkers(layer, comp, events) {
    var markerProp = layer.property("ADBE Marker");
    if (!markerProp) {
        $.writeln("Beat Detect: ERROR - Layer has no marker property");
        return 0;
    }
    
    var frameDur = comp.frameDuration;
    var created = 0;
    var bassCount = 0;
    var trebleCount = 0;
    
    for (var i = 0; i < events.length; i++) {
        var evt = events[i];
        var t = evt.time;
        var type = evt.type;
        
        var frameTime = Math.round(t / frameDur) * frameDur;
        
        if (frameTime < layer.inPoint - 0.001 || frameTime > layer.outPoint + 0.001) {
            $.writeln("Beat Detect: Skipping marker at " + frameTime + " (outside layer range)");
            continue;
        }
        
        var marker = new MarkerValue("");
        marker.comment = type === "BASS" ? "BASS" : "TREBLE";
        marker.label = type === "BASS" ? 1 : 4;
        marker.duration = 0;
        marker.chapter = false;
        marker.url = "";
        marker.frameTarget = false;
        marker.cuePointType = 0;
        
        try {
            markerProp.setValueAtTime(frameTime, marker);
            created++;
            if (type === "BASS") bassCount++; else trebleCount++;
            $.writeln("Beat Detect: Created " + type + " marker at " + frameTime);
        } catch (e) {
            $.writeln("Beat Detect: Failed to create marker at " + frameTime + ": " + e.message);
        }
    }
    
    $.writeln("Beat Detect: Marker creation complete - Bass: " + bassCount + ", Treble: " + trebleCount);
    return created;
}

function detectBeats(comp, layer, sensitivity, minGap, progressWin) {
    beatLog("detectBeats: started");
    $.writeln("Beat Detect: Starting detection pipeline...");
    
    if (!isAudioLayer(layer)) {
        $.writeln("Beat Detect: ERROR - Layer is not an enabled audio layer");
        return { success: false, error: "Layer is not an enabled audio layer." };
    }
    $.writeln("Beat Detect: Audio layer validated");
    
    var audioPath = exportAudioForAnalysis(layer, comp);
    beatLog("exportAudioForAnalysis returned: " + audioPath);
    if (!audioPath) {
        $.writeln("Beat Detect: ERROR - Could not access audio source");
        return {
            success: false,
            error: "Could not access audio source. Select a layer with a direct file-backed audio source (e.g. an imported WAV/MP3), not a rendered/nested/precomp source.",
            diag: lastAudioSourceDiag
        };
    }
    $.writeln("Beat Detect: Audio source ready: " + audioPath);
    
    var result = runBeatAnalyzer(audioPath, sensitivity, minGap, progressWin);
    
    // Only clean up temp WAV files, never the original source
    var tempAudio = new File(audioPath);
    if (tempAudio.exists && tempAudio.fsName.indexOf("temp_beat_audio_") !== -1) {
        tempAudio.remove();
        $.writeln("Beat Detect: Cleaned up temp audio file");
    }
    
    if (!result) {
        $.writeln("Beat Detect: ERROR - Beat analyzer failed or returned no data");
        return { success: false, error: "Beat analyzer failed or returned no data." };
    }
    
    if (result.error) {
        $.writeln("Beat Detect: ERROR - Python returned error: " + result.error);
        return { success: false, error: result.error };
    }
    
    if (!result || !result.length) {
        $.writeln("Beat Detect: No beats detected in audio");
        return { success: true, count: 0 };
    }
    
    $.writeln("Beat Detect: Got " + result.length + " detections, creating markers...");
    clearPreviousBeatMarkers(layer);
    var created = createBeatMarkers(layer, comp, result);
    
    $.writeln("Beat Detect: Created " + created + " markers");
    return { success: true, count: created };
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
    if (!sel || sel.length === 0) {
        alert("Please select a text layer.");
        return;
    }
    if (sel.length > 1) {
        alert("Please select only one text layer.");
        return;
    }

    var origLayer = sel[0];
    var textProps = origLayer.property("ADBE Text Properties");
    var textProp = textProps ? textProps.property("ADBE Text Document") : null;
    if (!textProp) {
        alert("Selected layer is not a text layer.");
        return;
    }

    var origTextDoc = textProp.value;
    var originalText = origTextDoc.text;
    if (!originalText || originalText.length === 0) {
        alert("Selected text layer is empty.");
        return;
    }

    app.beginUndoGroup("AE Panel - Chars");

    var measureLayer = null;
    try {
        var renderTime = comp.time;
        var is3D = origLayer.threeDLayer;
        var origPos = origLayer.position.value;
        var origAnchor = origLayer.anchorPoint.value;
        var origScale = origLayer.scale.value;
        var origRot = is3D ? 0 : origLayer.rotation.value;
        var origOpacity = origLayer.opacity.value;
        var origInPoint = origLayer.inPoint;
        var origOutPoint = origLayer.outPoint;
        var origStartTime = origLayer.startTime;
        var origParent = origLayer.parent;
        var origLabel = origLayer.label;
        var origJustification = origTextDoc.justification;

        var scaleX = origScale[0] / 100;
        var scaleY = origScale[1] / 100;
        var rotRad = origRot * Math.PI / 180;
        var cosRot = Math.cos(rotRad);
        var sinRot = Math.sin(rotRad);

        // Create a single temporary text layer for prefix measurements
        measureLayer = comp.layers.addText("");
        var measureProp = measureLayer.property("ADBE Text Properties").property("ADBE Text Document");
        var measureDoc = textProp.value;

        // Split text into individual lines to support multi-line text accurately
        var lines = originalText.split(/\r\n|[\r\n]/);
        var createdLayers = [];

        for (var lineIdx = 0; lineIdx < lines.length; lineIdx++) {
            var lineText = lines[lineIdx];
            if (!lineText || lineText.length === 0) continue;

            // Build newlines prefix to place measurement on the correct line baseline
            var linePrefixNewlines = "";
            for (var n = 0; n < lineIdx; n++) {
                linePrefixNewlines += "\r";
            }

            // Step 1: Measure line bounds with original justification
            measureDoc.justification = origJustification;
            measureDoc.text = linePrefixNewlines + lineText;
            measureProp.setValue(measureDoc);
            var lineBoundsOrig = measureLayer.sourceRectAtTime(renderTime, false);

            // Step 2: Measure cumulative prefix advances within the line using LEFT_JUSTIFY
            // to ensure a stable coordinate origin for glyph advance calculation
            measureDoc.justification = ParagraphJustification.LEFT_JUSTIFY;

            // Find first non-space character in the line
            var firstNonSpace = -1;
            for (var c = 0; c < lineText.length; c++) {
                var testCh = lineText.charAt(c);
                if (testCh !== " " && testCh !== "\t") {
                    firstNonSpace = c;
                    break;
                }
            }
            if (firstNonSpace === -1) continue; // entire line is whitespace

            // Measure baseline offset for this line relative to line 0
            var lineBaseline = 0;
            if (lineIdx > 0) {
                var refCh = lineText.charAt(firstNonSpace);
                measureDoc.text = refCh;
                measureProp.setValue(measureDoc);
                var refRect0 = measureLayer.sourceRectAtTime(renderTime, false);

                measureDoc.text = linePrefixNewlines + refCh;
                measureProp.setValue(measureDoc);
                var refRectL = measureLayer.sourceRectAtTime(renderTime, false);

                lineBaseline = refRectL.top - refRect0.top;
            }

            // Measure reference left position of first non-space character
            measureDoc.text = lineText.substring(0, firstNonSpace + 1);
            measureProp.setValue(measureDoc);
            var baseRect = measureLayer.sourceRectAtTime(renderTime, false);
            var baseLeft = baseRect.left;

            // Step 3: Iterate through characters on this line
            for (var charIdx = 0; charIdx < lineText.length; charIdx++) {
                var ch = lineText.charAt(charIdx);

                // Skip creating layers for whitespace characters; their advance is already captured
                if (ch === " " || ch === "\t") continue;

                // Measure prefix up to and including this character
                measureDoc.text = lineText.substring(0, charIdx + 1);
                measureProp.setValue(measureDoc);
                var prefixRect = measureLayer.sourceRectAtTime(renderTime, false);
                var rightEdge = prefixRect.left + prefixRect.width;

                // Create independent text layer for this character
                var charLayer = comp.layers.addText(ch);
                createdLayers.push(charLayer);

                // Copy original text document styling and set text to this character
                var charProp = charLayer.property("ADBE Text Properties").property("ADBE Text Document");
                var charDoc = textProp.value;
                charDoc.text = ch;
                charProp.setValue(charDoc);

                // Measure character bounds
                var charBounds = charLayer.sourceRectAtTime(renderTime, false);

                // Calculate horizontal offset within the line
                var charLeftInLine = rightEdge - charBounds.width;
                var charOffsetX = charLeftInLine - baseLeft;

                // Local position of character in original layer space
                var charLocalLeft = lineBoundsOrig.left + charOffsetX;

                // Set character anchor point to center of the character
                var charCenterX = charBounds.left + charBounds.width / 2;
                var charCenterY = charBounds.top + charBounds.height / 2;
                var charAnchor = is3D ? [charCenterX, charCenterY, 0] : [charCenterX, charCenterY];

                // Corresponding center in original layer local coordinates (aligned to baseline)
                var origCenterX = charLocalLeft + charBounds.width / 2;
                var origCenterY = lineBaseline + charCenterY;

                // Vector from original anchor point to character center
                var deltaX = origCenterX - origAnchor[0];
                var deltaY = origCenterY - origAnchor[1];

                // Transform local delta to comp/parent coordinates
                var compDeltaX = deltaX * scaleX * cosRot - deltaY * scaleY * sinRot;
                var compDeltaY = deltaX * scaleX * sinRot + deltaY * scaleY * cosRot;

                var newPos = is3D
                    ? [origPos[0] + compDeltaX, origPos[1] + compDeltaY, origPos[2]]
                    : [origPos[0] + compDeltaX, origPos[1] + compDeltaY];

                // If 3D, try to use world matrix if available
                if (is3D && typeof origLayer.toWorld === "function") {
                    try {
                        var worldPoint = origLayer.toWorld([origCenterX, origCenterY, origAnchor[2] || 0]);
                        if (origParent && typeof origParent.fromWorld === "function") {
                            newPos = origParent.fromWorld(worldPoint);
                        } else if (!origParent) {
                            newPos = worldPoint;
                        }
                    } catch (eWorld) {}
                }

                // Apply transforms
                charLayer.anchorPoint.setValue(charAnchor);
                charLayer.position.setValue(newPos);
                charLayer.scale.setValue(origScale);
                if (!is3D) {
                    charLayer.rotation.setValue(origRot);
                } else {
                    charLayer.threeDLayer = true;
                    try { charLayer.orientation.setValue(origLayer.orientation.value); } catch (e) {}
                    try { charLayer.xRotation.setValue(origLayer.xRotation.value); } catch (e) {}
                    try { charLayer.yRotation.setValue(origLayer.yRotation.value); } catch (e) {}
                    try { charLayer.zRotation.setValue(origLayer.zRotation.value); } catch (e) {}
                }
                charLayer.opacity.setValue(origOpacity);

                // Preserve layer timing and properties
                charLayer.inPoint = origInPoint;
                charLayer.outPoint = origOutPoint;
                charLayer.startTime = origStartTime;
                if (origLabel > 0) charLayer.label = origLabel;
                charLayer.name = ch;

                if (origParent) {
                    try { charLayer.parent = origParent; } catch (eParent) {}
                }
            }
        }

        // Clean up measurement layer immediately
        if (measureLayer) {
            try { measureLayer.remove(); } catch (eRem) {}
            measureLayer = null;
        }

        // Arrange layers in timeline directly above original layer in natural reading order
        for (var i = 0; i < createdLayers.length; i++) {
            try {
                createdLayers[i].moveBefore(origLayer);
            } catch (eMove) {}
        }

        // Disable visibility on original layer to reveal separated characters
        origLayer.enabled = false;

    } catch (err) {
        alert("Chars error: " + err.message);
    } finally {
        if (measureLayer) {
            try { measureLayer.remove(); } catch (eFinally) {}
        }
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
        $.writeln("getCameraWorldTransformAtTime failed: " + e.message);
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
        win.margins = 0;
        win.spacing = 0;

        var g = win.add("group");
        g.orientation = "column";
        g.alignChildren = "fill";
        g.margins = 6;
        g.spacing = 4;

        // ===== VERSION TITLE =====
        var titleGroup = g.add("group");
        titleGroup.orientation = "row";
        titleGroup.alignment = ["center", "center"];

        var titleText = titleGroup.add("statictext", undefined, "AE Tools  v1.0");
        titleText.alignment = ["center", "center"];
        try {
            titleText.graphics.font = ScriptUI.newFont("Arial", "BOLD", 11);
        } catch(e) {}

        var titleSep = g.add("panel");
        titleSep.alignChildren = "fill";
        titleSep.margins = 0;
        titleSep.height = 1;
        titleSep.minimumSize = [0, 1];

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
            b.preferredSize = [sz, 20];
            b.minimumSize = [sz, 20];
            b.maximumSize = [sz, 20];
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
            try {
                titleText.graphics.font = ScriptUI.newFont("Arial", "BOLD", 11);
            } catch (e) {}

            var btnGroup = section.add("group");
            btnGroup.orientation = "row";
            btnGroup.alignment = ["center", "center"];
            btnGroup.alignChildren = ["center", "center"];
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
            sep.maximumSize = [9999, 1];
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
        }, 43);

        btn(createRow,"Adj Layer","Create adjustment layer (white solid) for effects", function(){
            perSelection(function(c,l,i){
                var a=c.layers.addSolid([1,1,1],"Adj "+(i+1),c.width,c.height,c.pixelAspect);
                a.adjustmentLayer=true;a.label=11;
                if(l){a.startTime=l.startTime;a.inPoint=l.inPoint;a.outPoint=l.outPoint;a.moveBefore(l);}
            },true);
        }, 58);

        btn(createRow, "Solid", "Create a new solid layer", function() {
            var c = AE.requireComp();
            if (!c) return;
            app.beginUndoGroup("AE Panel - Solid");
            var countBefore = c.numLayers;
            app.executeCommand(2038);
            app.endUndoGroup();
        }, 43);

        btn(createRow, "Text", "Create text layer for typography and titles", function () {
            var c = AE.requireComp();
            if (!c) return;

            var targetLayer = c.selectedLayers.length ? c.selectedLayers[0] : null;

            app.beginUndoGroup("AE Panel - Text");

            // ── STEP 1: Create new text layer ──────────────────────────────
            var t = c.layers.addText("Text 1");
            t.label = 5;

            // Inherit timing from reference layer
            if (targetLayer) {
                t.startTime = targetLayer.startTime;
                t.inPoint   = targetLayer.inPoint;
                t.outPoint  = targetLayer.outPoint;
                t.moveBefore(targetLayer);
            }

            // ── STEP 3: Force AE to compute text bounds ────────────────────
            // Split undo groups so AE commits the text layer before we read bounds
            app.endUndoGroup();
            app.beginUndoGroup("AE Panel - Text Anchor");
            $.sleep(200);
            try { app.refresh(); } catch(e) {}

            // ── STEP 4: Center anchor (existing behavior — preserved) ───────
            try {
                var rect = t.sourceRectAtTime(c.time, false);
                if (rect && rect.width > 0) {
                    var cx = rect.left + rect.width / 2;
                    var cy = rect.top  + rect.height / 2;
                    var anc = t.anchorPoint.value;
                    var pos = t.position.value;
                    t.anchorPoint.setValue([anc[0] + cx, anc[1] + cy]);
                    t.position.setValue([pos[0] + cx, pos[1] + cy]);
                }
            } catch (eAnc) {
                $.writeln("Anchor center failed: " + eAnc.message);
            }

            // ── STEP 5: Camera-aware 3D placement ──────────────────────────
            try {
                var activeCam = null;
                try { activeCam = c.activeCamera; } catch (eCam) {}

                if (activeCam) {
                    // Make the text layer 3D so it can live in 3D space
                    t.threeDLayer = true;

                    // Evaluate camera's full world transform at current playhead
                    var camXF = getCameraWorldTransformAtTime(activeCam);

                    if (camXF) {
                        // Choose placement distance in front of camera
                        var dist = getCameraPlacementDistance(c, activeCam);

                        // World-space target point = camera pos + (forward * dist)
                        var targetWorld = [
                            camXF.pos[0] + camXF.fwd[0] * dist,
                            camXF.pos[1] + camXF.fwd[1] * dist,
                            camXF.pos[2] + camXF.fwd[2] * dist
                        ];

                        // Convert the world-space target into the text layer's
                        // LOCAL position space. The text layer has no parent so
                        // fromWorld() on any world point == world coords, but
                        // if the text layer somehow gets a parent we still handle
                        // it correctly via fromWorld on the layer itself.
                        var localPos;
                        try {
                            localPos = t.fromWorld(targetWorld);
                        } catch (eFW) {
                            localPos = targetWorld; // fallback: world == local (unparented)
                        }

                        // Bake position — no expression
                        t.position.setValue([localPos[0], localPos[1], localPos[2]]);

                        // ── Orient text to face the camera ─────────────────
                        // We want the text to face directly toward the camera.
                        // The camera looks along +fwd; text should face -fwd (back at cam).
                        //
                        // AE orientation is XYZ Euler (degrees). We derive the
                        // orientation angles from the camera's world axes so
                        // the text plane is perpendicular to the camera's view ray.
                        //
                        // Strategy: build a rotation matrix from camera axes
                        // and decompose to XYZ Euler:
                        //
                        //   text X-axis = camera right
                        //   text Y-axis = camera up   (opposite of camera down)
                        //   text Z-axis = -camera forward  (face toward camera)
                        //
                        // We use the camera's right/up/fwd already computed.

                        var rx = camXF.right;   // text layer's local X in world
                        var ry = camXF.up;       // text layer's local Y in world
                        var rz = [               // text layer's local Z = -fwd
                            -camXF.fwd[0],
                            -camXF.fwd[1],
                            -camXF.fwd[2]
                        ];

                        // Decompose rotation matrix [rx|ry|rz] → XYZ Euler (degrees)
                        // Using standard AE/right-handed decomposition:
                        //
                        //   R = Rx * Ry * Rz
                        //
                        // Matrix columns are the world-space directions:
                        //   col0 = rx, col1 = ry, col2 = rz
                        //
                        //   [ rx[0]  ry[0]  rz[0] ]
                        //   [ rx[1]  ry[1]  rz[1] ]
                        //   [ rx[2]  ry[2]  rz[2] ]
                        //
                        // Standard ZYX decomposition (matches AE Euler XYZ order):
                        //   ry_angle = -asin(rz[0])
                        //   rx_angle =  atan2(rz[1], rz[2])
                        //   rz_angle =  atan2(ry[0], rx[0])

                        var R20 = rz[0]; // m[2][0] in column-major = rz's x component
                        var R21 = rz[1];
                        var R22 = rz[2];
                        var R10 = ry[0];
                        var R00 = rx[0];

                        var degX, degY, degZ;
                        var clamped = Math.max(-1, Math.min(1, -R20));
                        degY = Math.asin(clamped) * 180 / Math.PI;

                        var cosY = Math.cos(degY * Math.PI / 180);
                        if (Math.abs(cosY) > 0.0001) {
                            degX = Math.atan2(R21 / cosY, R22 / cosY) * 180 / Math.PI;
                            degZ = Math.atan2(R10 / cosY, R00 / cosY) * 180 / Math.PI;
                        } else {
                            // Gimbal lock — degenerate case, zero out roll
                            degX = Math.atan2(-rz[1], ry[1]) * 180 / Math.PI;
                            degZ = 0;
                        }

                        // Bake orientation — use xRotation/yRotation/zRotation
                        // which are the individual-axis controls in AE 3D layers.
                        // These are set in degrees and applied AFTER orientation.
                        // Reset orientation to zero first, then set the axes.
                        try { t.orientation.setValue([0, 0, 0]); } catch (eO) {}
                        try { t.xRotation.setValue(degX); } catch (eX) {}
                        try { t.yRotation.setValue(degY); } catch (eY) {}
                        try { t.zRotation.setValue(degZ); } catch (eZ) {}
                    }
                }
            } catch (eCamPlace) {
                $.writeln("Camera placement failed (non-fatal): " + eCamPlace.message);
                // Text layer is still created correctly above — just without camera placement
            }

            app.endUndoGroup();
        }, 43);

        var createRow2 = createSec.section.add("group");
        createRow2.orientation = "row";
        createRow2.alignment = ["center", "center"];
        createRow2.alignChildren = ["center", "center"];
        createRow2.margins = 0;
        createRow2.spacing = 3;

        btn(createRow2, "Chars", "Separate text into individual character layers", function () {
            separateTextToCharacters();
        }, 88);

        addSeparator();

        // ===== TIMING =====
        var timingSec = addSection("Timing");

        var utilRow2 = timingSec.section.add("group");
        utilRow2.orientation = "row";
        utilRow2.alignment = ["center", "center"];
        utilRow2.alignChildren = ["center", "center"];
        utilRow2.margins = 0;
        utilRow2.spacing = 4;

        btn(utilRow2, "1F Adj", "Create single-frame adjustment layer at playhead", function(){
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

        btn(utilRow2, "Beats", "Detect BASS/TREBLE onsets on selected audio layer", function(){
            try {
                beatLog("=== Beats clicked ===");
                var c = AE.requireComp();
                if (!c) return;

                var sel = c.selectedLayers;
                if (sel.length !== 1) {
                    alert("Select exactly one audio layer.");
                    return;
                }

                var layer = sel[0];
                if (!isAudioLayer(layer)) {
                    alert("Select an audio layer.");
                    return;
                }
                beatLog("isAudioLayer result: " + isAudioLayer(layer));

                // Show progress dialog
                var progressWin = new Window("palette", "Beat Detection", undefined, {closeButton: false});
                progressWin.orientation = "column";
                progressWin.alignChildren = "fill";
                progressWin.margins = 15;
                progressWin.spacing = 10;
                
                var statusText = progressWin.add("statictext", undefined, "Validating audio layer...");
                statusText.alignment = ["center", "center"];
                
                var progressBar = progressWin.add("progressbar", undefined, 0, 100);
                progressBar.preferredSize = [300, 20];
                
                var cancelRow = progressWin.add("group");
                cancelRow.orientation = "row";
                cancelRow.alignment = ["center", "center"];
                cancelRow.spacing = 6;
                
                progressWin.cancelled = false;
                var cancelBtn = cancelRow.add("button", undefined, "Cancel", { style: "toolbutton" });
                cancelBtn.preferredSize = [80, 22];
                cancelBtn.minimumSize = [80, 22];
                cancelBtn.maximumSize = [80, 22];
                cancelBtn.onClick = function() {
                    progressWin.cancelled = true;
                };
                
                progressWin.show();
                progressWin.update();

                app.beginUndoGroup("AE Panel - Beat Detect");

                var sensitivity = "medium";
                var minGap = 0.12;

                // Stage 1: Validate
                progressBar.value = 10;
                statusText.text = "Validating audio...";
                progressWin.update();

                // Stage 2: Prepare audio
                progressBar.value = 20;
                statusText.text = "Preparing audio...";
                progressWin.update();

                var result = detectBeats(c, layer, sensitivity, minGap, progressWin);

                // Stage 4: Create markers
                progressBar.value = 90;
                statusText.text = "Creating markers...";
                progressWin.update();

                app.endUndoGroup();

                progressBar.value = 100;
                statusText.text = "Complete";
                progressWin.update();
                $.sleep(300);
                progressWin.close();

                if (!result.success) {
                    var msg = "Beat Detect failed: " + (result.error || "Unknown error");
                    if (result.diag) {
                        msg += "\n\nDiagnostic info:\n";
                        for (var dk in result.diag) {
                            try {
                                msg += dk + ": " + result.diag[dk] + "\n";
                            } catch (e) {}
                        }
                    }
                    alert(msg);
                } else if (result.count === 0) {
                    alert("No beats detected.");
                } else {
                    alert("Beat Detect complete: " + result.count + " markers created.");
                }
            } catch (e) {
                alert("BEATS HANDLER CRASHED: " + e.message + " (line " + e.line + ")\n\n" + e.stack);
            }
        }, 62);

        addSeparator();

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

        btn(twixtorRow, "Seq Keys", "Snap selected keyframes to first key (1-frame spacing)", function(){
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

        btn(twixtorRow, "Seq Lay", "Arrange selected layers end-to-end (no gaps)", sequenceSelectedLayers, 96);

        addSeparator();

        // ===== ANCHOR =====
        var anchorSec = addSection("Anchor");

        var anchorContent = anchorSec.section.add("group");
        anchorContent.orientation = "column";
        anchorContent.alignment = ["center", "center"];
        anchorContent.alignChildren = ["center", "center"];
        anchorContent.margins = 0;
        anchorContent.spacing = 2;

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
                var b = rowGroup.add("button", undefined, label, {style: "toolbutton"});
                b.preferredSize = [24, 20];
                b.minimumSize = [24, 20];
                b.maximumSize = [24, 20];

                try {
                    b.graphics.backgroundColor = b.graphics.newBrush(
                        b.graphics.BrushType.SOLID_COLOR,
                        [0.2, 0.3, 0.6, 1]
                    );
                } catch(e) {}

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

        addSeparator();

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
                    newLayer.inPoint = data.inPoint;
                    newLayer.outPoint = data.outPoint;
                }
            }

            app.endUndoGroup();
        }, 64);

        btn(tRow1, "Fit Comp", "Crop composition to layer bounds (supports rotation & scale)", cropCompToSelection, 62);

        win.layout.layout(true);
        return win;
    }

    var p = buildUI(thisObj);
    if (p instanceof Window) { p.center(); p.show(); }
}

    AE_Utility_Panel(thisObj);
}(this));

