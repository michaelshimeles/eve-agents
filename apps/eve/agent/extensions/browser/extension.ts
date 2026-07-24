import browser from "@agent-browser/eve";

// Mounts the browser__ tools (navigate, snapshot, click, fill, screenshot,
// ...) backed by agent-browser running inside the agent's sandbox, plus an
// instructions fragment teaching the snapshot-refs workflow.
//
// Directory mount so rarely-used tools can be removed from the always-on
// prompt: every advertised tool schema ships with every model call, so the
// sibling tools/*.ts disableTool() sentinels trim dead weight (dev-console
// debugging, drag/hover, multi-tab, uploads). Re-enable one by deleting its
// sentinel file. select_option stays: click alone can't drive native
// dropdowns; checkboxes toggle fine with click, so set_checked goes.
export default browser({});
