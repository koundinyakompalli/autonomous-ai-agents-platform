import { ScenarioType } from './types.js';
import { createLogger } from '../../utils/logger.js';

const logger = createLogger('bcat-scenario-detector');

/**
 * Detect BCAT scenario type from filename, JIRA title, or sheet names.
 * Priority: filename → title keywords → sheet name patterns
 */
export class ScenarioDetector {
  detectScenario(filename: string, title: string, sheetNames: string[]): ScenarioType {
    const filenameLower = filename.toLowerCase();
    const titleLower = title.toLowerCase();

    // Priority 1: Filename-based detection
    if (filenameLower.includes('letter')) return ScenarioType.LETTERS;
    if (filenameLower.includes('assessment')) return ScenarioType.ASSESSMENTS;
    if (filenameLower.includes('upgrade') || filenameLower.includes('release note')) return ScenarioType.UPGRADES;
    if (filenameLower.includes('workbook') || filenameLower.includes('solution')) return ScenarioType.WORKBOOKS;
    if (filenameLower.includes('auto task') || filenameLower.includes('auto tasking')) return ScenarioType.AUTO_TASKING;

    // Priority 2: Title-based detection
    if (titleLower.includes('letter')) return ScenarioType.LETTERS;
    if (titleLower.includes('assessment')) return ScenarioType.ASSESSMENTS;
    if (titleLower.includes('bc upgrade') || titleLower.includes('release note')) return ScenarioType.UPGRADES;
    if (titleLower.includes('workbook') || titleLower.includes('solution')) return ScenarioType.WORKBOOKS;
    if (titleLower.includes('auto task') || titleLower.includes('auto tasking')) return ScenarioType.AUTO_TASKING;

    // Priority 3: Sheet name patterns
    const sheetNamesLower = sheetNames.map(s => s.toLowerCase());
    const hasIndicator = sheetNamesLower.some(s => s.includes('indicator') || s === 'sheet1');
    const hasLetterLike = sheetNamesLower.some(s => s.includes('letter'));
    const hasAssessmentLike = sheetNamesLower.some(s => s.includes('assessment') || s.includes('assess'));
    const hasUpgradeLike = sheetNamesLower.some(s => s.includes('upgrade'));
    const hasWorkbookLike = sheetNamesLower.some(s => s.includes('workbook') || s.includes('solution'));

    if (hasLetterLike) return ScenarioType.LETTERS;
    if (hasAssessmentLike) return ScenarioType.ASSESSMENTS;
    if (hasUpgradeLike) return ScenarioType.UPGRADES;
    if (hasWorkbookLike) return ScenarioType.WORKBOOKS;

    // Heuristic: multiple sheets with non-indicator names → likely assessments/workbooks
    const dataSheets = sheetNames.filter(s => {
      const sl = s.toLowerCase();
      return !sl.includes('indicator') && sl !== 'sheet1' && sl !== 'instructions';
    });

    if (dataSheets.length > 1) {
      return ScenarioType.ASSESSMENTS; // default multi-sheet scenario
    }

    logger.warn({ filename, title, sheetNames }, '[BCAT_DETECT] Could not determine scenario type, defaulting to UNKNOWN');
    return ScenarioType.UNKNOWN;
  }
}
