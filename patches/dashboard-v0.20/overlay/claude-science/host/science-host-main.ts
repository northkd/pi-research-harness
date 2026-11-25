/** Standalone transport shell. Trusted registry/browser composition is supplied by host code. */
import { createScienceHostDaemon } from "@blackbelt-technology/pi-dashboard-server/science-host-daemon";

const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== "--private-dir") {
  process.stderr.write("science-host-private-directory-required\n"); process.exitCode = 2;
} else {
  try {
    const daemon = createScienceHostDaemon({ privateDir: args[1], observe: event => { process.stdout.write(`${JSON.stringify(event)}\n`); } });
    await daemon.start();
    let closing = false;
    const close = () => { if (closing) return; closing = true; void daemon.close().then(() => { process.exitCode = 0; }, () => { process.stderr.write("science-host-close-unavailable\n"); process.exitCode = 1; }); };
    process.once("SIGTERM", close); process.once("SIGINT", close);
  } catch { process.stderr.write("science-host-start-unavailable\n"); process.exitCode = 1; }
}
