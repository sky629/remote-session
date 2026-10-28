import { render } from "preact";
import { App } from "./app.tsx";
import { boot } from "./store.ts";

render(<App />, document.getElementById("app")!);
void boot();
navigator.serviceWorker?.register("/sw.js").catch(() => {});
