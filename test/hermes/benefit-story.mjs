/** @module User benefits and matching native footage for the Peekumi review story. */
export const benefitStory = [
  {
    id: "intro",
    title: "Stay in control as agents change your code",
    detail: "Keep a clear view of your repository inside Hermes.",
    narration:
      "Agents can change a lot of code. Keeping up shouldn't mean reading every line. Peekumi gives you a clear view of your repository, right inside Hermes.",
  },
  {
    id: "overview",
    title: "See the structure and dependencies at a glance",
    detail:
      "Folders, files and functions stay connected. Changed areas stand out.",
    narration:
      "See your folders, files and functions, and how they depend on each other. Changed areas stand out, so you know where to focus your review.",
  },
  {
    id: "drill",
    title: "Drill into the parts that need your attention",
    detail: "Select a file, then a function. Use the diff for exact code.",
    narration:
      "Start with the big picture, then select a file or function to inspect it. Use the supporting diff when you need the exact code.",
  },
  {
    id: "rule",
    title: "Catch problems in the context of your repo",
    detail:
      "An untested refund function and a forbidden UI-to-database dependency.",
    narration:
      "Here, the map flags an untested refund function and a dependency that breaks the project's rules. Select the red edge to see exactly what's wrong.",
  },
  {
    id: "repair",
    title: "Give your agent specific findings to fix",
    detail:
      "Peekumi's gate returns the findings. The agent repairs and measures again.",
    narration:
      "Peekumi sends specific findings back to the agent. It removes the forbidden import, adds refund tests, and measures the change again.",
  },
  {
    id: "verify",
    title: "Review the repair with fresh evidence",
    detail:
      "Coverage 100%. Measured risk 42 → 6. The dependency violation is gone.",
    narration:
      "Review the repair: coverage reaches one hundred percent, measured risk falls from forty two to six, and the dependency violation is gone.",
  },
  {
    id: "close",
    title: "Keep your repo knowledge. Review more changes.",
    detail: "Let agents handle the detail while you stay in control.",
    narration:
      "Keep your knowledge of the repo while agents handle the detail. Review more changes, drill into what matters, and stay in control.",
  },
];
