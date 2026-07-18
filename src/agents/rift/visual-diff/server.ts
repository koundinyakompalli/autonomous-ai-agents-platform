/**
 * RIFT Visual Diff Server
 *
 * Express API for comparing actual code content between two git branches.
 * Uses git diff (content-based), NOT git log (commit-based), so cherry-picked
 * code with different commit IDs won't appear as false differences.
 */

import express from 'express';
import { execSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());

const REPOS_BASE = process.env.REPOS_BASE || '/mnt/efs/specter-repo/repositories';

const REPO_CONFIG: Record<string, { path: string }> = {
    'core-app': { path: `${REPOS_BASE}/core-app` },
    'batch-jobs': { path: `${REPOS_BASE}/batch-jobs` },
    'client-services': { path: `${REPOS_BASE}/client-services` },
    'provider-portal': { path: `${REPOS_BASE}/provider-portal` },
};

function git(repoPath: string, cmd: string): string {
    try {
        return execSync(`git -C "${repoPath}" ${cmd}`, {
            encoding: 'utf-8',
            maxBuffer: 50 * 1024 * 1024,
            timeout: 180_000,
        }).trim();
    } catch (e: any) {
        throw new Error(`git error: ${e.stderr || e.message}`);
    }
}

function gitSafe(repoPath: string, cmd: string): string {
    try {
        return git(repoPath, cmd);
    } catch {
        return '';
    }
}

function resolveBranch(repoPath: string, branchName: string): string {
    try {
        git(repoPath, `rev-parse --verify ${branchName}`);
        return branchName;
    } catch {
        const remote = `remotes/origin/${branchName}`;
        git(repoPath, `rev-parse --verify ${remote}`);
        return remote;
    }
}

// --- API Routes ---

app.get('/api/repos', (_req, res) => {
    const repos = Object.keys(REPO_CONFIG).map(name => ({
        name,
        path: REPO_CONFIG[name].path,
    }));
    res.json(repos);
});

app.get('/api/branches/:repo', (req, res) => {
    const config = REPO_CONFIG[req.params.repo];
    if (!config) return res.status(404).json({ error: 'Repository not found' });

    try {
        const raw = git(config.path, 'branch -a');
        const allBranches = raw
            .split('\n')
            .map(b => b.replace('*', '').trim())
            .map(b => b.replace('remotes/origin/', ''))
            .filter((b, i, arr) => arr.indexOf(b) === i);

        const versionBranches = allBranches
            .filter(b => /^(\d+\.\d+(?:\.\d+)?)$/.test(b))
            .sort((a, b) => {
                const va = a.split('.').map(Number);
                const vb = b.split('.').map(Number);
                for (let i = 0; i < Math.max(va.length, vb.length); i++) {
                    if ((va[i] || 0) !== (vb[i] || 0)) return (va[i] || 0) - (vb[i] || 0);
                }
                return 0;
            });

        // Include default branch aliases at the end if they exist
        if (allBranches.includes('master')) {
            versionBranches.push('master');
        }
        if (allBranches.includes('main')) {
            versionBranches.push('main');
        }

        res.json(versionBranches);
    } catch (e: any) {
        res.status(500).json({ error: e.message });
    }
});

type ChangeMode = 'missed_retrofits' | 'enhancements' | 'all';

interface ChangedFile {
    path: string;
    oldPath?: string;
    status: 'modified' | 'added' | 'deleted' | 'renamed';
    direction: 'missed_retrofit' | 'enhancement' | 'both';
    additions: number;
    deletions: number;
}

app.get('/api/changes/:repo', (req, res) => {
    const config = REPO_CONFIG[req.params.repo];
    if (!config) return res.status(404).json({ error: 'Repository not found' });

    const { oldBranch, newBranch, mode = 'all', compareType = 'content' } = req.query as {
        oldBranch: string;
        newBranch: string;
        mode: ChangeMode;
        compareType?: 'content' | 'commit';
    };

    if (!oldBranch || !newBranch) {
        return res.status(400).json({ error: 'oldBranch and newBranch are required' });
    }

    try {
        const oldRef = resolveBranch(config.path, oldBranch);
        const newRef = resolveBranch(config.path, newBranch);

        if (compareType === 'commit') {
            return commitBasedChanges(config.path, oldRef, newRef, mode as ChangeMode, oldBranch, newBranch, res);
        }

        // Content-based comparison with -w to ignore whitespace differences
        const nameStatusRaw = gitSafe(config.path, `diff -w -M --name-status ${oldRef} ${newRef}`);
        const numstatRaw = gitSafe(config.path, `diff -w -M --numstat ${oldRef} ${newRef}`);

        const statusMap = new Map<string, ChangedFile['status']>();
        const renameMap = new Map<string, string>(); // newPath → oldPath
        if (nameStatusRaw) {
            for (const line of nameStatusRaw.split('\n')) {
                if (!line.trim()) continue;
                // Handle renames: R100\told_path\tnew_path
                const renameMatch = line.match(/^R\d*\t(.+)\t(.+)$/);
                if (renameMatch) {
                    statusMap.set(renameMatch[2], 'renamed');
                    renameMap.set(renameMatch[2], renameMatch[1]);
                    continue;
                }
                // Handle copy: C100\tsrc_path\tdst_path
                const copyMatch = line.match(/^C\d*\t(.+)\t(.+)$/);
                if (copyMatch) {
                    statusMap.set(copyMatch[2], 'added');
                    continue;
                }
                const match = line.match(/^([AMD])\t(.+)$/);
                if (match) {
                    const s = match[1];
                    const p = match[2];
                    statusMap.set(p,
                        s === 'A' ? 'added' :
                        s === 'D' ? 'deleted' : 'modified'
                    );
                }
            }
        }

        const files: ChangedFile[] = [];

        if (numstatRaw) {
            for (const line of numstatRaw.split('\n')) {
                if (!line.trim()) continue;
                const parts = line.split('\t');
                if (parts.length < 3) continue;

                // Binary files show as: -\t-\tpath
                const isBinary = parts[0] === '-' && parts[1] === '-';
                const additions = isBinary ? 0 : (parseInt(parts[0]) || 0);
                const deletions = isBinary ? 0 : (parseInt(parts[1]) || 0);

                // Handle rename paths from git numstat:
                //   prefix/{old => new}/suffix  e.g. MedicalMgmt/src/{ => main/java}/com/...
                //   old_path => new_path
                let filePath = parts.slice(2).join('\t');
                let oldFilePath: string | undefined;
                const braceMatch = filePath.match(/^(.*)\{(.*?) => (.*?)\}(.*)$/);
                if (braceMatch) {
                    const prefix = braceMatch[1];
                    const oldPart = braceMatch[2];
                    const newPart = braceMatch[3];
                    const suffix = braceMatch[4];
                    filePath = (prefix + newPart + suffix).replace(/\/\//g, '/');
                    oldFilePath = (prefix + oldPart + suffix).replace(/\/\//g, '/');
                } else {
                    const arrowMatch = filePath.match(/^(.+) => (.+)$/);
                    if (arrowMatch) {
                        oldFilePath = arrowMatch[1];
                        filePath = arrowMatch[2];
                    }
                }
                // Also check renameMap from name-status (for non-brace renames)
                if (!oldFilePath && renameMap.has(filePath)) {
                    oldFilePath = renameMap.get(filePath);
                }

                // Skip build artifacts
                if (filePath.includes('/target/') || filePath.endsWith('.class')) continue;

                // Direction based on actual content changes (old → new perspective):
                //   deletions > 0 means lines in old are missing from new = missed_retrofit
                //   additions > 0 means lines in new are not in old = enhancement
                const status = statusMap.get(filePath) || 'modified';
                let direction: ChangedFile['direction'];

                if (status === 'deleted') {
                    direction = 'missed_retrofit';
                } else if (status === 'added') {
                    direction = 'enhancement';
                } else if (isBinary) {
                    direction = 'both';
                } else if (deletions > 0 && additions > 0) {
                    direction = 'both';
                } else if (deletions > 0) {
                    direction = 'missed_retrofit';
                } else {
                    direction = 'enhancement';
                }

                // Apply mode filter
                if (mode === 'missed_retrofits' && direction === 'enhancement') continue;
                if (mode === 'enhancements' && direction === 'missed_retrofit') continue;

                const entry: ChangedFile = { path: filePath, status, direction, additions, deletions };
                if (oldFilePath) entry.oldPath = oldFilePath;
                files.push(entry);
            }
        }

        files.sort((a, b) => a.path.localeCompare(b.path));

        res.json({
            oldBranch,
            newBranch,
            mode,
            totalFiles: files.length,
            files,
        });
    } catch (e: any) {
        res.status(500).json({ error: e.message });
    }
});

function commitBasedChanges(
    repoPath: string, oldRef: string, newRef: string,
    mode: ChangeMode, oldBranch: string, newBranch: string,
    res: express.Response
) {
    const filesMap = new Map<string, ChangedFile>();

    function parseLogs(logOutput: string, direction: 'missed_retrofit' | 'enhancement') {
        if (!logOutput) return;
        let currentCommit = '';
        for (const line of logOutput.split('\n')) {
            if (line.startsWith('COMMIT:')) {
                currentCommit = line.substring(7).split('|')[0]?.substring(0, 12) || '';
                continue;
            }
            const match = line.match(/^([AMDRC])\t(.+)$/);
            if (!match || !currentCommit) continue;
            const filePath = match[2];
            if (filePath.includes('/target/') || filePath.endsWith('.class')) continue;
            const statusChar = match[1];
            const status: ChangedFile['status'] =
                statusChar === 'A' ? 'added' :
                statusChar === 'D' ? 'deleted' :
                statusChar === 'R' ? 'renamed' : 'modified';

            const existing = filesMap.get(filePath);
            if (existing) {
                if (existing.direction !== direction) existing.direction = 'both';
            } else {
                filesMap.set(filePath, {
                    path: filePath, status, direction,
                    additions: 0, deletions: 0,
                });
            }
        }
    }

    if (mode === 'missed_retrofits' || mode === 'all') {
        const missedLog = gitSafe(repoPath,
            `log ${newRef}..${oldRef} --name-status --pretty=format:"COMMIT:%H|%s|%an|%ad" --date=short`);
        parseLogs(missedLog, 'missed_retrofit');
    }
    if (mode === 'enhancements' || mode === 'all') {
        const enhLog = gitSafe(repoPath,
            `log ${oldRef}..${newRef} --name-status --pretty=format:"COMMIT:%H|%s|%an|%ad" --date=short`);
        parseLogs(enhLog, 'enhancement');
    }

    const files = Array.from(filesMap.values())
        .sort((a, b) => a.path.localeCompare(b.path));

    res.json({
        oldBranch, newBranch, mode,
        totalFiles: files.length,
        files,
    });
}

type Criticality = 'high' | 'medium' | 'low';

interface ClassifiedCommit {
    hash: string;
    message: string;
    criticality: Criticality;
    reason: string;
}

const LOW_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
    { pattern: /^\+\s*import\s/m, reason: 'import change' },
    { pattern: /TextAreaItem\b.*\bMHTextAreaItem|MHTextAreaItem\b.*\bTextAreaItem/i, reason: 'widget rename (TextAreaItem → MHTextAreaItem)' },
    { pattern: /TextItem\b.*\bMHTextItem|MHTextItem\b.*\bTextItem/i, reason: 'widget rename (TextItem → MHTextItem)' },
    { pattern: /SelectItem\b.*\bMHSelectItem|MHSelectItem\b.*\bSelectItem/i, reason: 'widget rename (SelectItem → MHSelectItem)' },
    { pattern: /StaticTextItem\b.*\bMHStaticTextItem|MHStaticTextItem\b.*\bStaticTextItem/i, reason: 'widget rename (StaticTextItem → MHStaticTextItem)' },
    { pattern: /Logger\b|\.log\(|\.info\(|\.debug\(|\.warn\(|\.error\(|GWT\.log\(|System\.out\.print|\.trace\(/, reason: 'logging change' },
    { pattern: /\/\/\s|\/\*|\*\//, reason: 'comment change' },
    { pattern: /copyright|Copyright|@author|@since|@version|@deprecated/i, reason: 'metadata/annotation change' },
    { pattern: /^\+\s*$|^\-\s*$/m, reason: 'blank line change' },
    { pattern: /\.toString\(\)|\.trim\(\)|String\.valueOf/, reason: 'cosmetic string operation' },
    { pattern: /pom\.xml|version>|<dependency>|<groupId>|<artifactId>/, reason: 'build config change' },
];

const HIGH_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
    { pattern: /SQL|sql|@Query|@NamedQuery|HQL|createQuery|createSQLQuery|nativeQuery|JdbcTemplate/, reason: 'SQL/query change' },
    { pattern: /DELETE\s+FROM|DROP\s+TABLE|TRUNCATE|ALTER\s+TABLE/i, reason: 'destructive SQL' },
    { pattern: /@Transactional|@Transaction|commit\(\)|rollback\(\)/, reason: 'transaction boundary change' },
    { pattern: /SecurityContext|authentication|Authorization|password|credential|token|encrypt|decrypt/i, reason: 'security/auth change' },
    { pattern: /\.save\(|\.update\(|\.delete\(|\.persist\(|\.merge\(|\.remove\(|\.flush\(/, reason: 'data persistence change' },
    { pattern: /throw\s+new|catch\s*\(|Exception\b/, reason: 'error handling change' },
    { pattern: /if\s*\(|else\s*\{|switch\s*\(|case\s+|while\s*\(|for\s*\(/, reason: 'control flow change' },
    { pattern: /new\s+\w+\(|\.getInstance\(|@Autowired|@Inject/, reason: 'object creation/injection change' },
    { pattern: /null\s*[!=]=|!=\s*null|==\s*null|\.equals\(/, reason: 'null/equality check change' },
    { pattern: /return\s+|void\s+\w+\s*\(|public\s+\w+\s+\w+\s*\(|private\s+\w+\s+\w+\s*\(/, reason: 'method signature/return change' },
    { pattern: /cron|schedule|timer|@Scheduled|batch|job/i, reason: 'scheduling/batch change' },
    { pattern: /REST|@RequestMapping|@GetMapping|@PostMapping|@PutMapping|@DeleteMapping|endpoint/i, reason: 'API endpoint change' },
    { pattern: /flyway|migration|V\d+\.\d+/i, reason: 'database migration' },
];

function classifyDiff(diffText: string): { criticality: Criticality; reason: string } {
    if (!diffText || !diffText.trim()) return { criticality: 'low', reason: 'empty diff' };

    // Extract only changed lines (+ and - lines, not context)
    const changedLines = diffText.split('\n')
        .filter(l => (l.startsWith('+') || l.startsWith('-')) && !l.startsWith('+++') && !l.startsWith('---'))
        .join('\n');

    if (!changedLines.trim()) return { criticality: 'low', reason: 'no code changes' };

    // Check high criticality first
    for (const { pattern, reason } of HIGH_PATTERNS) {
        if (pattern.test(changedLines)) {
            return { criticality: 'high', reason };
        }
    }

    // Check low criticality
    let allLow = true;
    let lowReason = '';
    for (const { pattern, reason } of LOW_PATTERNS) {
        if (pattern.test(changedLines)) {
            lowReason = reason;
        }
    }

    // If we only found low-criticality patterns and the diff is small
    const addedLines = changedLines.split('\n').filter(l => l.startsWith('+')).length;
    const removedLines = changedLines.split('\n').filter(l => l.startsWith('-')).length;
    const totalChanged = addedLines + removedLines;

    if (lowReason && totalChanged <= 20) {
        return { criticality: 'low', reason: lowReason };
    }

    return { criticality: 'medium', reason: totalChanged > 50 ? 'large code change' : 'functional code change' };
}

function classifyCommitFast(message: string): { criticality: Criticality; reason: string } {
    const msg = message.toLowerCase();

    // High: security, SQL, hotfix, critical bug references
    if (/sql|query|migration|security|auth|hotfix|critical|crash|data.?loss|corrupt/i.test(message)) {
        return { criticality: 'high', reason: 'critical keyword in commit message' };
    }
    if (/fix|bug|defect|issue|error|exception|null|npe|cpsup|cpdev/i.test(message)) {
        return { criticality: 'high', reason: 'bug fix' };
    }

    // Low: refactor, rename, format, log, docs, version bump
    if (/refactor|rename|format|cleanup|clean.up|style|lint|typo|comment|log|version|bump|merge/i.test(message)) {
        return { criticality: 'low', reason: msg.includes('merge') ? 'merge commit' : 'non-functional change' };
    }
    if (/config|tmplt|template/i.test(message)) {
        return { criticality: 'low', reason: 'configuration/template change' };
    }

    return { criticality: 'medium', reason: 'functional change' };
}

function parseCommitLines(commits: string[]): ClassifiedCommit[] {
    return commits.map(c => {
        const parts = c.split(' ');
        const hash = parts[0];
        const message = parts.slice(1).join(' ');
        const { criticality, reason } = classifyCommitFast(message);
        return { hash, message, criticality, reason };
    });
}

app.get('/api/diff/:repo', (req, res) => {
    const config = REPO_CONFIG[req.params.repo];
    if (!config) return res.status(404).json({ error: 'Repository not found' });

    const { oldBranch, newBranch, filePath, oldPath: oldPathParam } = req.query as {
        oldBranch: string;
        newBranch: string;
        filePath: string;
        oldPath?: string;
    };

    if (!oldBranch || !newBranch || !filePath) {
        return res.status(400).json({ error: 'oldBranch, newBranch, and filePath are required' });
    }

    try {
        const oldRef = resolveBranch(config.path, oldBranch);
        const newRef = resolveBranch(config.path, newBranch);

        // For renamed files, the path on the old branch differs from the new branch
        const oldFilePath = oldPathParam || filePath;

        const qNewPath = `'${filePath.replace(/'/g, "'\\''")}'`;
        const qOldPath = `'${oldFilePath.replace(/'/g, "'\\''")}'`;

        // Use branch-specific paths for show
        const oldContent = gitSafe(config.path, `show "${oldRef}":${qOldPath}`);
        const newContent = gitSafe(config.path, `show "${newRef}":${qNewPath}`);

        // -w ignores whitespace-only differences
        const diff = gitSafe(config.path, `diff -w "${oldRef}" "${newRef}" -- ${qOldPath} ${qNewPath}`);

        // Only show commits if there are actual content differences for this file.
        // This prevents showing cherry-picked commits that have different IDs
        // but identical code on both branches.
        let missedRetrofits: ClassifiedCommit[] = [];
        let enhancements: ClassifiedCommit[] = [];

        if (diff) {
            const missedRetrofitsRaw = gitSafe(config.path,
                `log "${newRef}".."${oldRef}" --oneline -- ${qOldPath}`)
                .split('\n').filter(Boolean);
            const enhancementsRaw = gitSafe(config.path,
                `log "${oldRef}".."${newRef}" --oneline -- ${qNewPath}`)
                .split('\n').filter(Boolean);

            missedRetrofits = parseCommitLines(missedRetrofitsRaw);
            enhancements = parseCommitLines(enhancementsRaw);
        }

        res.json({
            filePath,
            oldBranch,
            newBranch,
            oldContent,
            newContent,
            diff,
            missedRetrofits,
            enhancements,
        });
    } catch (e: any) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/commit-diff/:repo', (req, res) => {
    const config = REPO_CONFIG[req.params.repo];
    if (!config) return res.status(404).json({ error: 'Repository not found' });

    const { commitHash, filePath } = req.query as { commitHash: string; filePath: string };
    if (!commitHash || !filePath) {
        return res.status(400).json({ error: 'commitHash and filePath are required' });
    }

    try {
        const qPath = `'${filePath.replace(/'/g, "'\\''")}'`;
        const diff = gitSafe(config.path, `diff -w "${commitHash}~1" "${commitHash}" -- ${qPath}`);
        const { criticality, reason } = classifyDiff(diff);
        res.json({ commitHash, filePath, diff, criticality, reason });
    } catch (e: any) {
        res.status(500).json({ error: e.message });
    }
});

// Serve static UI
app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const PORT = parseInt(process.env.PORT || '3847');
app.listen(PORT, () => {
    console.log(`RIFT Visual Diff running at http://localhost:${PORT}`);
});
