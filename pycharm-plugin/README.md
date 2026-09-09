# HypoTrace for PyCharm port plan

The VS Code implementation is the runnable hackathon build. JetBrains plugins are a separate IntelliJ Platform artifact and cannot load a `.vsix`.

To make the port after the demo:

1. In IntelliJ IDEA or PyCharm, create an IntelliJ Platform Plugin project using the current JetBrains Plugin Template.
2. Add a `DocumentListener` that emits the same sanitized `EDIT_BURST` object, a `FileEditorManagerListener` for `NAVIGATION`, and a daemon-analysis listener that emits diagnostic severity categories only.
3. Persist the same profile schema with `PropertiesComponent` or a project service. Never copy editor text, raw key events, clipboard content, or `.env` / secret files.
4. Add a `ToolWindowFactory` named HypoTrace that renders the dashboard fields from this repository; add actions for Start Session, Load Demo, Probe, and Record Transfer Test.
5. Run the plugin in a sandbox IDE from the Gradle `runIde` task, then install its generated ZIP through **Settings → Plugins → gear icon → Install Plugin from Disk**.

For the September 10 demo, show the working VS Code extension. Present this folder as the deliberate cross-IDE port contract, not a falsely claimed PyCharm release.
