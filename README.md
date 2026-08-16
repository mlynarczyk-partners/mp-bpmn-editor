# BPMN Editor

A lightweight BPMN 2.0 diagram editor built on top of [bpmn-js](https://bpmn.io/). It runs entirely in the browser as a static HTML/JS app — no backend, no build step, nothing to install. Diagrams are opened and saved directly to your local disk via the browser's File System Access API.

Made by [Mlynarczyk & Partners](https://mlynarczyk-partners.com).

## Features

### Core editing
- Full BPMN 2.0 element set via bpmn-js: tasks (and all subtypes), events, gateways, sub-processes, call activities, pools/lanes, data objects, groups, text annotations, sequence/message flows, and associations — with drag-and-drop palette, context pad, undo/redo, and zoom-to-fit.
- All task-shaped elements are resizable (bpmn-js only allows this for containers by default).
- Changing an element's type (e.g. Task → Service Task, or → Sub-Process) preserves its original position and size instead of resetting to the library default.
- A configurable default size for newly created tasks, applied consistently across every task subtype.

### File handling
- New / Open… / Save .bpmn, using the native file picker (File System Access API) with a download-based fallback for browsers that don't support it.
- Drag-and-drop import of `.bpmn` / `.xml` files.
- Auto-save: a debounced, silent write-back to the currently open file once it's been opened or saved through the native picker.
- The last file you had open is remembered (via an IndexedDB-stored file handle) and silently restored on reload, or offered with a one-click prompt if the browser requires explicit permission.
- A "Close file" button clears the canvas and forgets the remembered file.

### Process structure & navigation
- A resizable "Process structure" side panel listing the main process plus nested sub-processes and Call Activities, for jumping directly to any level of a diagram.
- A breadcrumb trail for drilling in and out of sub-processes.
- Call Activities can be linked to a target sub-process, or converted back to a plain Task.

### Properties panel
- Name, type, editable size, fill color, and free-text description for the selected element.
- "System" and "Location" tags, drawn from user-defined dictionaries (see Settings below), with an optional "extended details" mode that overlays colored badges and a details-link icon directly on the canvas.
- Collapsible, with its state remembered between sessions.

### Settings
- Manage reusable "Systems" and "Locations" dictionaries (name + color), shared across diagrams and embedded into each `.bpmn` file so they travel with it.
- Configure the default size for newly created tasks.

### Visual customization
- A curated color palette plus custom colors. Groups and Text Annotations — which bpmn-js normally renders without any fill — get their own background tinting so a chosen color is actually visible, with automatic text-contrast correction for annotations.
- Pools and lanes render fully transparent so the background grid shows through.
- An optional visual grid (off / 10px / 50px).

### XML panel
- View and hand-edit the underlying XML, re-import it, or copy it to the clipboard.

### Convert to M&P BPMN
- Files from other tools often wrap a single process in a `bpmn:collaboration`/pool, which this editor's structure panel doesn't recognize. When the conversion can be done without discarding anything (exactly one pool, no message flows), a one-click button flattens the file to a plain process.

## Getting started

This is a static app with no build step and no dependencies to install:

1. Clone the repository.
2. Open `index.htm` directly in a Chromium-based browser (Chrome, Edge, Brave, Arc).
3. Start diagramming — use New or Open… to get going.

If you'd rather not open the file directly (some browsers restrict File System Access API features on `file://` pages), serve the folder with any static file server, e.g.:

```bash
npx serve .
```

### Browser support

Native Open / Save / Auto-save rely on the File System Access API, currently available in Chromium-based browsers (Chrome, Edge, Brave, Arc, Opera). In other browsers the editor still works, but saving falls back to a plain file download instead of writing back to the original file.

## License

MIT — see [LICENSE](LICENSE).

## Credits

Made by [Mlynarczyk & Partners](https://mlynarczyk-partners.com).
