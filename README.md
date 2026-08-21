# BPMN Editor

A lightweight BPMN 2.0 diagram editor built on top of [bpmn-js](https://bpmn.io/). It runs entirely in the browser as a static HTML/JS app — no backend, no build step, nothing to install. Diagrams are opened and saved directly to your local disk via the browser's File System Access API.

Alongside regular process diagrams, it supports Collaboration diagrams (pools, participants, lanes) and a Choreography Task shape for documenting message-driven interactions between participants.

Made by [Mlynarczyk & Partners](https://mlynarczyk-partners.com/en/home/).

## Features

### Core editing
- Full BPMN 2.0 element set via bpmn-js: tasks (and all subtypes), events, gateways, sub-processes, call activities, pools/lanes, data objects, groups, text annotations, sequence/message flows, and associations — with drag-and-drop palette, context pad, undo/redo, and zoom-to-fit.
- All task-shaped elements are resizable (bpmn-js only allows this for containers by default).
- Changing an element's type (e.g. Task → Service Task, or → Sub-Process) preserves its original position and size instead of resetting to the library default.
- A configurable default size for newly created tasks, applied consistently across every task subtype.
- Rich text: select part of a label, task band, or text annotation and press Ctrl/Cmd+B to bold it. Bold-aware word-wrapping and auto-grow keep text annotations and rotated pool/participant names correctly sized and centered as you edit.
- The palette is organized into labeled sections — General tools, Choreography, and Collaboration — separated by dividers, so the always-available tools stay visually distinct from the shape libraries below them.

### Collaboration diagrams
- Use **Create pool/participant** to start a Collaboration diagram — a pool represents a participant (an organization, system, or role) and can be split into lanes. Pool and lane backgrounds render fully transparent so the canvas grid stays visible through them.

### Choreography Task
- The **Choreography Task** palette tool drops a task-like shape split into three independently editable bands — Header, Body, and Footer. Double-click any band to edit it in place: Enter to confirm, Shift+Enter for a line break, Escape to cancel, Ctrl/Cmd+B to bold a selection.
- A context-pad icon swaps the Header/Footer band colors without retyping anything.
- Message envelopes: a small **+** button above and below a selected Choreography Task attaches a message envelope (one per zone), connected to the task with a dotted association. Envelopes can be captioned the same way as a band (Enter/Shift+Enter/Escape/bold), keep a fixed icon size regardless of caption length, and can be repositioned between "beside" and "below" the icon via their own context-pad toggle.

### File handling
- New / Open… / Save, using the native file picker (File System Access API) with a download-based fallback for browsers that don't support it.
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
- An optional visual grid (off / 10px / 50px) for on-canvas alignment guides. Shape dragging and resizing always snap to a configurable grid spacing (default 10px, adjustable in Settings), independent of whether the grid lines are currently shown.

### XML panel
- View and hand-edit the underlying XML, re-import it, or copy it to the clipboard.

### Built-in user guide
- A "?" button opens an in-app guide covering the whole app, organized into three tabs — Interface, Process diagrams, and Collaborations — available in English, Polish, and Russian, with your last-used language and tab remembered between visits.

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

Made by [Mlynarczyk & Partners](https://mlynarczyk-partners.com/en/home/).
