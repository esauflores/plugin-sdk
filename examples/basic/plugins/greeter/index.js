// A published plugin: plain JS (Node won't strip types inside node_modules).
// In a real package you'd type it with: /** @type {import("your-app").Plugin<{ punctuation: string }>} */
export default {
  name: "greeter",
  version: "1.0.0",
  dependsOn: ["clock"],
  setup(ctx) {
    const clock = ctx.use("clock");
    ctx.hooks.on("greeting:render", (text, who) => `${text}, ${who}${ctx.options.punctuation} (${clock.now()})`);
  },
};
