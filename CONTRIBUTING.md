# Contributing to MediaGrabber PRO

Thank you for your interest in contributing to **MediaGrabber PRO**! We welcome contributions from everyone. Whether you're fixing a bug, adding support for a new stream format, improving the UI, or polishing documentation, your help is appreciated.

---

## Code of Conduct

By participating in this project, you agree to abide by common standards of respect, inclusivity, and constructive collaboration.

---

## How to Contribute

### 1. Reporting Issues & Bug Reports

Before submitting a bug report, please check the [existing issues](https://github.com/Cathhdyy/Web-Video-Downloader-Extenstion/issues) to avoid duplicates.

When creating an issue, please include:
- **Operating System & Browser version** (e.g., Windows 11, Chrome 128)
- **Extension version** (e.g., `1.1.0`)
- **Detailed description of the issue**
- **Steps to reproduce**
- **URL or sample media stream** (if publicly accessible and legal to share)
- **Console error logs** (from the background service worker or popup DevTools)

---

### 2. Feature Requests & Enhancements

Have an idea to make MediaGrabber PRO better?
- Open an issue with the label `enhancement`.
- Describe the feature, why it is useful, and potential implementation approaches.

---

### 3. Local Development Setup

1. **Clone the repository:**
   ```bash
   git clone https://github.com/Cathhdyy/Web-Video-Downloader-Extenstion.git
   cd Web-Video-Downloader-Extenstion
   ```

2. **Load the extension into your browser:**
   - Open Chrome / Brave / Edge and navigate to `chrome://extensions/` (or `brave://extensions/`, `edge://extensions/`).
   - Enable **Developer mode** (toggle in the top-right corner).
   - Click **Load unpacked**.
   - Select the root folder of this repository.

3. **Open the Test Lab:**
   - Navigate to `chrome-extension://<EXTENSION_ID>/test_lab/test_lab.html` or launch it via the extension Options menu to test stream detection locally.

4. **Generating Icons (optional):**
   - If you modify icon geometry, re-run:
     ```bash
     npm run generate-icons
     ```

---

### 4. Pull Request Guidelines

1. **Fork** the repository and create your branch from `main`:
   ```bash
   git checkout -b feature/amazing-feature
   ```
2. **Follow existing coding style**:
   - Write clean, modern, vanilla JavaScript (ES6+).
   - Use descriptive variable and function names.
   - Maintain the existing dark mode glassmorphism UI styling in `popup.css` and `options.css`.
3. **Test thoroughly**:
   - Test regular MP4/WebM video downloads.
   - Test audio file downloads (MP3/M4A/WAV).
   - Test multi-segment HLS streams using the built-in Test Lab.
   - Verify that no unwanted permissions are added to `manifest.json`.
4. **Commit with clear messages**:
   ```bash
   git commit -m "feat: add support for encrypted HLS key extraction"
   ```
5. **Submit a Pull Request** to the `main` branch with a clear summary of your changes.

---

## License

By contributing to this repository, you agree that your contributions will be licensed under the project's [PolyForm Noncommercial License 1.0.0](LICENSE).
