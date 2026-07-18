# Examples

## Run DARCI directly against a local repo

```ts
import { DARCIAgent } from 'specter';

const agent = new DARCIAgent({
  repositoryPath: '/mnt/efs/specter-repo/repositories/core-app',
});

const result = await agent.analyze('Users cannot log in after password reset');
console.log(result.analysis);
```

## Use the shared runner directly

```ts
import {
  runAgent,
  registerRepoFromPath,
  TOOL_SETS,
} from 'specter';

const repoId = registerRepoFromPath('/mnt/efs/specter-repo/repositories/core-app');

const result = await runAgent({
  taskId: `custom-${Date.now()}`,
  taskPrompt: 'Summarize how authentication tokens are validated',
  repoIds: [repoId],
  allowedTools: TOOL_SETS.code_exploration,
  readOnly: true,
  outputSchema: {
    type: 'object',
    properties: {
      summary: { type: 'string' },
    },
    required: ['summary'],
  },
});
```

## Start a worker locally

```bash
WORKER_TYPE=SCRIBE STATUS_PORT=8080 npm run worker
curl http://localhost:8080/status
```

## Start Harvey locally

```bash
HARVEY_PORT=3978 npm run harvey
curl http://localhost:3978/health
```

## Add a custom wrapper

```ts
import {
  runAgent,
  registerRepoFromPath,
  TOOL_SETS,
} from '../../claude-sdk/index.js';

export class EndpointSummaryAgent {
  private repoId: string;

  constructor(repositoryPath: string) {
    this.repoId = registerRepoFromPath(repositoryPath);
  }

  async summarize(endpoint: string) {
    return runAgent({
      taskId: `endpoint-summary-${Date.now()}`,
      taskPrompt: `Explain how ${endpoint} works end to end.`,
      repoIds: [this.repoId],
      allowedTools: TOOL_SETS.code_exploration,
      readOnly: true,
    });
  }
}
```

## Teams commands worth testing

Once Harvey is connected to Teams, useful commands are:

- `/new`
- `/sessions`
- `/status`
- `/help`
- `/history`
- `/cancel`
- `/share`

Those commands are handled in `src/harvey/TeamsBot.ts`.
