# Student Center

Student Center is a college-life planning app built around one trustworthy loop: import academic information, review it, build a realistic plan, recommend the next action, and adapt when circumstances change.

## Current vertical slice

- Responsive My Day product experience with PWA support.
- Review-before-import syllabus flow with evidence and confidence.
- Pure deterministic scheduling, overload conflicts, next-action ranking, and recovery replanning.
- Versioned API routes for planning, recommendations, imports, Canvas validation, and AI brain dumps.
- Provider-neutral AI gateway with an OpenAI structured-output adapter.
- Canvas connector contract with personal-token and future OAuth authentication shapes.
- D1 schema for students, preferences, courses, tasks, commitments, plans, imports, connections, and domain events.
- Tauri 2 Windows/macOS shell scaffold.

## Local development

Requires Node.js 22+.

```bash
npm install
npm run dev
```

Open `http://localhost:3000`. Use `npm run check`, `npm test`, and `npm run build` for validation.

Optional managed AI configuration:

```text
OPENAI_API_KEY=
OPENAI_MODEL=gpt-5.6-luna
```

The app continues to work without an AI key; deterministic planning never depends on the model.

## Trust boundaries

Imported candidates require approval before canonical records change. Canvas access is read-only. Dates, capacity, conflicts, and recommendations are deterministic. Never commit Canvas or OpenAI credentials.
