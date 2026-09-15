#!/usr/bin/env python3
"""
Audio Beat Detector for After Effects
Detects BASS and TREBLE onsets using band-limited spectral flux with adaptive thresholding.
"""

import sys
import json
import argparse
import tempfile
import os

import numpy as np
import librosa
import scipy.signal
import scipy.ndimage


BASS_FMIN, BASS_FMAX = 20.0, 150.0
TREBLE_FMIN, TREBLE_FMAX = 3000.0, 16000.0

SENSITIVITY_DELTAS = {
    "low": 0.25,
    "medium": 0.12,
    "high": 0.05,
}

DEFAULT_SENSITIVITY = "medium"
DEFAULT_MIN_GAP = 0.12
HOP_LENGTH = 512
N_FFT = 2048
LOCAL_WINDOW_SEC = 4.0
SMOOTH_WINDOW_SEC = 0.02


def load_audio(path):
    y, sr = librosa.load(path, sr=None, mono=True)
    return y, sr


def band_energy_envelope(y, sr, fmin, fmax):
    S = np.abs(librosa.stft(y, n_fft=N_FFT, hop_length=HOP_LENGTH))
    freqs = librosa.fft_frequencies(sr=sr, n_fft=N_FFT)
    nyq = sr / 2.0
    fmax = min(fmax, nyq)
    mask = (freqs >= fmin) & (freqs <= fmax)
    if not mask.any():
        return None, HOP_LENGTH / sr
    energy = S[mask].sum(axis=0)
    energy_db = 10.0 * np.log10(energy + 1e-12)
    return energy_db, HOP_LENGTH / sr


def detect_onsets(envelope_db, sr, hop_s, min_gap_s, delta):
    if envelope_db is None or len(envelope_db) < 4:
        return np.array([])

    diff = np.diff(envelope_db)
    diff = np.maximum(diff, 0.0)

    w_smooth = max(1, int(round(SMOOTH_WINDOW_SEC / hop_s)))
    if w_smooth > 1:
        diff = scipy.ndimage.uniform_filter1d(diff, size=w_smooth, mode="nearest")

    scale = np.percentile(diff[diff > 0], 90) if np.any(diff > 0) else 1e-6
    if scale < 1e-6:
        return np.array([])
    dn = diff / scale

    w_local = max(3, int(round(LOCAL_WINDOW_SEC / hop_s)))
    local_base = scipy.ndimage.median_filter(dn, size=w_local, mode="nearest")

    thr = local_base + delta

    w_dist = max(1, int(round(min_gap_s / hop_s)))

    dn_masked = np.where(dn >= thr, dn, -np.inf)
    peaks, _ = scipy.signal.find_peaks(dn_masked, distance=w_dist)

    times = peaks * hop_s
    return times


def analyse(path, sensitivity=DEFAULT_SENSITIVITY, min_gap=DEFAULT_MIN_GAP):
    sens = str(sensitivity).lower()
    if sens not in SENSITIVITY_DELTAS:
        sens = DEFAULT_SENSITIVITY
    delta = SENSITIVITY_DELTAS[sens]
    min_gap = float(min_gap)
    if min_gap <= 0:
        min_gap = DEFAULT_MIN_GAP

    y, sr = load_audio(path)
    if y is None or len(y) == 0:
        raise RuntimeError("no audio loaded")

    bass_env, hop_s = band_energy_envelope(y, sr, BASS_FMIN, BASS_FMAX)
    treble_env, _ = band_energy_envelope(y, sr, TREBLE_FMIN, TREBLE_FMAX)

    bass_times = detect_onsets(bass_env, sr, hop_s, min_gap, delta)
    treble_times = detect_onsets(treble_env, sr, hop_s, min_gap, delta)

    events = []
    for t in bass_times:
        events.append({"time": round(float(t), 6), "type": "BASS"})
    for t in treble_times:
        events.append({"time": round(float(t), 6), "type": "TREBLE"})

    events.sort(key=lambda e: e["time"])
    return events


def main(argv=None):
    p = argparse.ArgumentParser(description="AE audio beat detector (BASS / TREBLE onsets)")
    p.add_argument("input", help="path to audio file")
    p.add_argument("--sensitivity", default=DEFAULT_SENSITIVITY, choices=["low", "medium", "high"])
    p.add_argument("--min-gap", type=float, default=DEFAULT_MIN_GAP)
    p.add_argument("--json", dest="json_out", default=None)
    args = p.parse_args(argv)

    try:
        events = analyse(args.input, args.sensitivity, args.min_gap)
    except Exception as exc:
        result = {"error": str(exc)}
        _write(args.json_out, result)
        return 1

    _write(args.json_out, events)
    return 0


def _write(path, obj):
    text = json.dumps(obj)
    if path:
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(text)
    else:
        sys.stdout.write(text)


if __name__ == "__main__":
    sys.exit(main())