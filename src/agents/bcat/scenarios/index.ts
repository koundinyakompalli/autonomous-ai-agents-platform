import { ScenarioType } from '../types.js';
import { BaseScenario } from './BaseScenario.js';
import { LettersScenario } from './LettersScenario.js';
import { AssessmentsScenario } from './AssessmentsScenario.js';
import { UpgradesScenario } from './UpgradesScenario.js';
import { WorkbooksScenario } from './WorkbooksScenario.js';
import { AutoTaskingScenario } from './AutoTaskingScenario.js';

export function getScenarioHandler(type: ScenarioType): BaseScenario {
  switch (type) {
    case ScenarioType.LETTERS: return new LettersScenario();
    case ScenarioType.ASSESSMENTS: return new AssessmentsScenario();
    case ScenarioType.UPGRADES: return new UpgradesScenario();
    case ScenarioType.WORKBOOKS: return new WorkbooksScenario();
    case ScenarioType.AUTO_TASKING: return new AutoTaskingScenario();
    default:
      // Default to Letters (row-per-ticket, no attachment) for unknown types
      return new LettersScenario();
  }
}

export { BaseScenario } from './BaseScenario.js';
export { LettersScenario } from './LettersScenario.js';
export { AssessmentsScenario } from './AssessmentsScenario.js';
export { UpgradesScenario } from './UpgradesScenario.js';
export { WorkbooksScenario } from './WorkbooksScenario.js';
export { AutoTaskingScenario } from './AutoTaskingScenario.js';
