# Adapt Web Client

Interact with Adapt directly from your browser: https://app.adapt.chat

## What's this? 

This is the official web-based client and Progressive Web App (PWA) for the [Adapt chat platform](https://adapt.chat). 

## Roadmap

See the [project board](https://github.com/orgs/AdaptChat/projects/2/views/4?layout=board) for the current status of the
web client.

## Desktop Builds

- Windows:
  - [x86_64 (64 bit)](https://download.adapt.chat/webclient/windows-x86_64/Adapt-setup.exe)
  - [i686 (32 bit)](https://download.adapt.chat/webclient/windows-i686/Adapt-setup.exe)
- MacOS:
  - x86_64 (Intel): [.app bundle](https://download.adapt.chat/webclient/darwin-x86_64/Adapt.app.zip) | [.dmg installer](https://download.adapt.chat/webclient/darwin-x86_64/Adapt-installer.dmg)
  - aarch64 (Apple Silicon): [.app bundle](https://download.adapt.chat/webclient/darwin-aarch64/Adapt.app.zip) | [.dmg installer](https://download.adapt.chat/webclient/darwin-aarch64/Adapt-installer.dmg)
- Linux (x86_64/AMD64):
  - [.deb](https://download.adapt.chat/webclient/linux-x86_64/Adapt.deb) (smaller, but might need to install dependencies)
  - [AppImage](https://download.adapt.chat/webclient/linux-x86_64/Adapt.AppImage) (larger, easier to install)

## Building from Source

You can run the Adapt client locally using [Vite](https://vitejs.dev/).

### Prerequisites
- [Node.js](https://nodejs.org/) **v18 or later**
- [npm](https://npmjs.com) or some other package manager

### Clone the repository
```bash
git clone https://github.com/AdaptChat/webclient.git
cd webclient
```

### Install dependencies
```bash
npm install
```

### Start development server
```bash
npm run dev
```

### Build for production
```bash
npm run build
```

To preview the production build locally:

```bash
npm run serve
```

### Building for Desktop from Source

You can choose to build the client as a desktop app using [Tauri](https://tauri.app/):

```bash
npm run tauri build
```
