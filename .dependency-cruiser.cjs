/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    { name: "no-circular", severity: "error", from: {}, to: { circular: true } },
    {
      name: "no-orphans",
      severity: "warn",
      from: { orphan: true, pathNot: ["\\.d\\.ts$", "^src/main\\.tsx$", "\\.test\\.ts$", "vite-env"] },
      to: {},
    },
    // Layering (spec §42): ui -> rendering -> (simulation | data); nothing imports ui except app.
    {
      name: "rendering-must-not-import-ui",
      severity: "error",
      from: { path: "^src/rendering" },
      to: { path: "^src/(components|pages|app)" },
    },
    {
      name: "simulation-must-not-import-rendering-or-ui",
      severity: "error",
      from: { path: "^src/(simulation|workers)" },
      to: { path: "^src/(rendering|components|pages|app)" },
    },
    {
      name: "data-must-not-import-upwards",
      severity: "error",
      from: { path: "^src/data" },
      to: { path: "^src/(rendering|simulation|workers|components|pages|app)" },
    },
    {
      name: "types-are-leaves",
      severity: "error",
      from: { path: "^src/types" },
      to: { path: "^src/(?!types)" },
    },
    {
      name: "benchmark-must-not-import-ui",
      severity: "error",
      from: { path: "^src/benchmark" },
      to: { path: "^src/(components|pages|app)" },
    },
    {
      name: "no-react-in-engine",
      severity: "error",
      from: { path: "^src/(rendering|simulation|data|workers|benchmark)" },
      to: { path: "^react" },
    },
    { name: "scripts-are-standalone", severity: "error", from: { path: "^scripts" }, to: { path: "^src" } },
    {
      name: "server-uses-pure-layers-only",
      severity: "error",
      from: { path: "^server" },
      to: { path: "^src/(rendering|map|components|pages|app|benchmark|workers)" },
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: "tsconfig.json" },
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["import", "require", "node", "default", "types"],
    },
    reporterOptions: { text: { highlightFocused: true } },
  },
};
