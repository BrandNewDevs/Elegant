// A stand-in engine process for adapter tests. Speaks the JSON-lines protocol on stdio.
//   node stub-engine.mjs            behaves, exits on a shutdown command
//   node stub-engine.mjs stubborn   ignores shutdown (to test the kill timeout)
import { createInterface } from "node:readline";

const stubborn = process.argv[2] === "stubborn";

// The ready event arrives in two chunks, to prove lines are reassembled.
process.stdout.write('{"type":"ready",');
setTimeout(() => {
  process.stdout.write('"version":"9.9.9"}\n');
  process.stdout.write("this is not json\n");
  process.stdout.write('{"type":"error","message":"boom"}\n{"type":"mic_in_use_started","app":"zoom.us","pid":42}\n');
}, 20);

createInterface({ input: process.stdin }).on("line", (line) => {
  const command = JSON.parse(line);
  if (command.type === "shutdown" && !stubborn) process.exit(0);
  if (command.type !== "shutdown") {
    // Echo any other command back, so tests can see exactly what the app sent.
    process.stdout.write(JSON.stringify({ type: "recording_started", app: `echo:${command.type}`, startedAt: "x" }) + "\n");
  }
});
