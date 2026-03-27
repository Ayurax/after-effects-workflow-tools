# 🎬 AE Utility Panel Script

A powerful **Adobe After Effects ScriptUI panel** that speeds up everyday workflows with utilities for anchor control, layer management, precomposing, camera rigs, and more.

---

## ✨ Features

### 🧭 Anchor Tools
- 3×3 Anchor Preset Grid (TL, TC, TR, etc.)
- Center Anchor Point (accurate with `sourceRectAtTime`)
- Works with:
  - 2D & 3D layers
  - Animated keyframes (preserves animation)

---

### 🧩 Layer Utilities
- **Decompose Precomp (Advanced)**
  - Preserves:
    - Timing (including stretch & time remap)
    - Parenting
    - Track mattes
    - Blending modes & layer properties
- **Precompose Layers Separately**
- Maintains original timing after operations

---

### ⚡ Quick Create Tools
- Null Object  
- Adjustment Layer  
- Solid (with color picker 🎨)  
- Text Layer  

---

### 🛠 Utilities
- **1-Frame Adjustment Layer**
- **Align Keyframes**
  - Automatically spaces selected keyframes frame-by-frame

---

### 🎥 Camera Rig
- One-click:
  - Camera creation
  - Controller null setup
  - Auto timing based on selected layers

---

## 📦 Installation

1. Download the script file (`.jsx`)
2. Place it in:

Adobe After Effects > Support Files > Scripts > ScriptUI Panels

3. Restart After Effects  
4. Open via:

Window > AE Utility Panel

---

## 🚀 Usage

- Select layers (if required)
- Click buttons in the panel

Most tools support:
- Multiple layers  
- Animated properties  
- Undo (grouped actions)  

---

## 🧠 How It Works

### Anchor Presets
Uses `sourceRectAtTime()` to calculate layer bounds and reposition anchor points without visually shifting the layer.

### Decompose System
- Copies layers from precomp to main comp  
- Maps time using:
  - `displayStartTime`
  - `stretch`
  - `timeRemap`
  - `inPoint`
- Rebuilds parenting relationships safely  

---

## ⚠️ Notes / Limitations

- Some layer types may not support `sourceRectAtTime`
- Certain effects or expressions may not transfer perfectly during decomposition
- Works best with standard AE layer types

---

## 🛠 Requirements

- Adobe After Effects (modern versions)
- ScriptUI enabled

---

## 📌 Future Improvements

- Batch processing tools  
- Expression utilities  
- Better error reporting UI  
- Preset saving  

---

## 🤝 Contributing

Feel free to fork and improve:
- Add features  
- Optimize performance  
- Improve UI/UX  

---

## 📄 License

MIT License
