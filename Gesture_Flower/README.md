# 🌸 Gesture Flower - 指尖花开

[English](#english) | [中文](#中文)

---

<a name="english"></a>
## 📖 English

**An interactive 3D flower controlled by hand gestures.**

This project is built with Three.js, MediaPipe Hands, and GLSL. It uses the webcam to detect your hand gestures and interacts with 3D particles in real-time.

### ✨ Features
*   **Bloom & Close**: Open your palm to bloom the flower, make a fist to close it.
*   **Two-Hand Bridge**: Show both hands to generate a gorgeous particle bridge.
*   **Pinch to Scale**: Use your index finger and thumb to pinch and control the size/thickness of the bridge.
*   **Peace Sign (✌️)**: Make a peace sign to scatter the flower and spell out "天天开心❤️" with particles.
*   **Single-Finger Drawing**: Extend only your index finger to draw a pink and white particle trail that fades in 5 seconds.
*   **Smooth Camera Toggle**: Press `C` to toggle the dark video background.

### 🚀 Quick Start
Because this project uses the webcam, **you cannot just double-click `index.html`**. It requires a local web server due to browser security policies (CORS).

1. **Download & Extract**: Download this repository and extract it.
2. **Run**: Double-click the `start.bat` file (Windows only). This will start a local Python server and open your browser automatically.
3. **Play**: Click "Allow" when the browser asks for camera permission.

*(Note: If `start.bat` fails, open your terminal in the folder and run `python -m http.server 5500`, then visit `http://localhost:5500`)*

### 📄 License
This project is licensed under the MIT License.

---

<a name="中文"></a>
## 📖 中文

**一个利用 Three.js 和 MediaPipe 打造的纯前端手势控制 3D 粒子花朵。**

这个项目不需要鼠标键盘，只需要对着摄像头做出手势，就能控制 3D 粒子花朵和特效。

### ✨ 核心特性
*   **绽放与闭合**：张开手掌花朵绽放，握拳花朵闭合。
*   **双手光桥**：识别双手时，生成绚丽的粒子拱桥，并跟随指尖移动。
*   **捏合控制**：大拇指与食指捏合/张开，可实时控制拱桥的粗细/大小。
*   **比耶特效 (✌️)**：单手比耶，花朵粒子散开并拼出“天天开心❤️”字样。
*   **单指绘画**：仅伸出单根食指，可在空中画出粉色与白色的粒子拖尾，5秒后平滑消失。
*   **暗色背景切换**：按键盘 `C` 键可切换摄像头背景。

### 🚀 极简使用方法（必看）
因为项目需要调用摄像头，受浏览器安全限制（CORS），**绝对不能直接双击 `index.html` 运行！** 必须通过本地服务器运行。

1. **下载解压**：下载本仓库并解压。
2. **一键运行**：双击文件夹里的 `start.bat` 文件（Windows系统）。它会自动启动 Python 本地服务器并打开浏览器。
3. **开始体验**：在浏览器弹出提示时，点击“允许”使用摄像头即可。

*(注：如果没有反应，请确保电脑安装了 Python 3，并在文件夹内打开命令行执行 `python -m http.server 5500`，然后浏览器访问 `http://localhost:5500`)*

### 📄 开源协议
本项目基于 MIT License 协议开源，欢迎随意修改和把玩！