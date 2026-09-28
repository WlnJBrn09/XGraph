# XGraph

XGraph is a local drawing editor built with the same Rust API, static web UI, and native WebView host used by XWrite, XSlide, and XSheet. The interface uses the suite’s sidebar, title bar, glass toolbar, inspector, solid work surface, light/dark themes, and local document library.

## Features

Rectangles, ellipses, lines, arrow connectors, text, freehand paths, embedded raster images, layer ordering, drag repositioning, optional grid and snapping, SVG, PNG, and ODG export.

- Open SVG, ODG, and XGraph JSON from the file picker or the user's Documents folder.
- Save editable documents in the local app store. The native host stores data under the platform app-data folder; `cargo run` uses `./documents`.
- Print or save a PDF through the browser's Print command.

## Run

```sh
cargo run
```

Open `http://127.0.0.1:8791`. To build and launch the native host:

```sh
npm run native
```

Run `npm run dist:deb` (Debian/Ubuntu) or `npm run dist:rpm` (Fedora/RHEL/openSUSE) to build a package. CI builds and smoke-tests both.

## File support

SVG import keeps common basic shapes and paths. ODG files exported by XGraph reopen with full editability; LibreOffice Draw displays their embedded SVG drawing. External ODG import supports embedded SVG drawings and basic rectangles, ellipses, circles, and lines. Other ODG shapes are rejected rather than silently dropped. Effects, gradients, and complex transformations remain outside the current editor format.

## License

MIT
