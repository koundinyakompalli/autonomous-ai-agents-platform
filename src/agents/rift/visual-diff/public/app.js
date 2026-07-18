const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

const repoSelect = $('#repoSelect');
const oldBranchSelect = $('#oldBranchSelect');
const newBranchSelect = $('#newBranchSelect');
const compareBtn = $('#compareBtn');
const loading = $('#loading');
const summary = $('#summary');
const mainContent = $('#mainContent');
const filePanel = $('#filePanel');
const commitPanel = $('#commitPanel');
const expandLeft = $('#expandLeft');
const expandRight = $('#expandRight');
const fileList = $('#fileList');
const fileCount = $('#fileCount');
const fileFilter = $('#fileFilter');
const diffContent = $('#diffContent');
const diffHeader = $('#diffHeader');
const diffFilePath = $('#diffFilePath');
const diffMeta = $('#diffMeta');
const tabRetrofits = $('#tabRetrofits');
const tabEnhancements = $('#tabEnhancements');
const tabRetrofitCount = $('#tabRetrofitCount');
const tabEnhCount = $('#tabEnhCount');
const clearCommitBtn = $('#clearCommitBtn');
const topSection = $('#topSection');
const topToggleBar = $('#topToggleBar');
const topToggleBtn = $('#topToggleBtn');
const topToggleIcon = $('#topToggleIcon');
const topToggleLabel = $('#topToggleLabel');
const topMiniSummary = $('#topMiniSummary');

let currentFiles = [];
let currentRepo = '';
let currentOld = '';
let currentNew = '';
let currentFileDiff = null;
let currentFileOldPath = null;
let topCollapsed = false;

// --- Top section collapse ---
topToggleBtn.addEventListener('click', () => {
    topCollapsed = !topCollapsed;
    topSection.classList.toggle('collapsed', topCollapsed);
    topToggleIcon.classList.toggle('down', topCollapsed);
    topToggleLabel.textContent = topCollapsed ? 'Show controls' : 'Hide controls';
});

// --- Panel collapse / expand ---
$$('.panel-toggle').forEach(btn => {
    btn.addEventListener('click', () => {
        const target = btn.dataset.target;
        if (target === 'filePanel') {
            filePanel.classList.add('hidden');
            expandLeft.classList.remove('hidden');
        } else if (target === 'commitPanel') {
            commitPanel.classList.add('hidden');
            expandRight.classList.remove('hidden');
        }
    });
});

expandLeft.addEventListener('click', () => {
    expandLeft.classList.add('hidden');
    filePanel.classList.remove('hidden');
});

expandRight.addEventListener('click', () => {
    expandRight.classList.add('hidden');
    commitPanel.classList.remove('hidden');
});

// --- Tabs ---
$$('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
        $$('.tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        const which = tab.dataset.tab;
        tabRetrofits.classList.toggle('active', which === 'retrofits');
        tabEnhancements.classList.toggle('active', which === 'enhancements');
    });
});

// --- API ---
async function api(path) {
    const res = await fetch(path);
    if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(err.error || 'Request failed');
    }
    return res.json();
}

async function loadRepos() {
    const repos = await api('/api/repos');
    repos.forEach(r => {
        const opt = document.createElement('option');
        opt.value = r.name;
        opt.textContent = r.name;
        repoSelect.appendChild(opt);
    });
}

async function loadBranches(repo) {
    oldBranchSelect.innerHTML = '<option value="">Select old branch...</option>';
    newBranchSelect.innerHTML = '<option value="">Select new branch...</option>';
    oldBranchSelect.disabled = true;
    newBranchSelect.disabled = true;
    if (!repo) return;
    try {
        const branches = await api(`/api/branches/${repo}`);
        branches.forEach(b => {
            const o1 = document.createElement('option');
            o1.value = b; o1.textContent = b;
            oldBranchSelect.appendChild(o1);
            const o2 = document.createElement('option');
            o2.value = b; o2.textContent = b;
            newBranchSelect.appendChild(o2);
        });
        oldBranchSelect.disabled = false;
        newBranchSelect.disabled = false;
    } catch (e) { console.error('Failed to load branches:', e); }
}

function updateCompareBtn() {
    compareBtn.disabled = !(repoSelect.value && oldBranchSelect.value && newBranchSelect.value);
}

// --- Compare ---
async function compare() {
    const repo = repoSelect.value;
    const oldBranch = oldBranchSelect.value;
    const newBranch = newBranchSelect.value;
    const mode = document.querySelector('input[name="mode"]:checked').value;
    const compareType = document.querySelector('input[name="compareType"]:checked').value;

    loading.classList.remove('hidden');
    summary.classList.add('hidden');
    mainContent.classList.add('hidden');
    compareBtn.disabled = true;

    try {
        const data = await api(`/api/changes/${repo}?oldBranch=${enc(oldBranch)}&newBranch=${enc(newBranch)}&mode=${mode}&compareType=${compareType}`);
        currentFiles = data.files;
        currentRepo = repo;
        currentOld = oldBranch;
        currentNew = newBranch;

        const rc = data.files.filter(f => f.direction === 'missed_retrofit').length;
        const ec = data.files.filter(f => f.direction === 'enhancement').length;
        const bc = data.files.filter(f => f.direction === 'both').length;

        summary.innerHTML = `
            <div class="stat"><span class="stat-value total">${data.totalFiles}</span> files with content differences</div>
            <div class="stat"><span class="stat-value retrofit">${rc}</span> lines removed</div>
            <div class="stat"><span class="stat-value enhancement">${ec}</span> lines added</div>
            <div class="stat"><span class="stat-value both">${bc}</span> modified</div>
        `;
        summary.classList.remove('hidden');
        renderFileList(data.files);
        mainContent.classList.remove('hidden');

        // Show toggle bar with mini summary
        topToggleBar.classList.remove('hidden');
        topMiniSummary.innerHTML = `
            <span class="mini-label">${currentRepo}</span>
            <span>${currentOld} &rarr; ${currentNew}</span>
            <span class="mini-stat">${data.totalFiles} files</span>
            <span class="mini-stat r">${rc} removed</span>
            <span class="mini-stat e">${ec} added</span>
            <span class="mini-stat b">${bc} modified</span>
        `;

        // Reset diff + commit panels
        diffContent.innerHTML = '<div class="empty-state">Select a file to view its diff</div>';
        diffHeader.classList.add('hidden');
        commitPanel.classList.add('hidden');
        expandRight.classList.add('hidden');
    } catch (e) { alert('Error: ' + e.message); }
    finally { loading.classList.add('hidden'); updateCompareBtn(); }
}

function enc(s) { return encodeURIComponent(s); }

function renderFileList(files) {
    const filter = fileFilter.value.toLowerCase();
    const filtered = filter ? files.filter(f => f.path.toLowerCase().includes(filter)) : files;
    fileCount.textContent = `${filtered.length} files`;

    fileList.innerHTML = filtered.map(f => `
        <div class="file-item" data-path="${esc(f.path)}" ${f.oldPath ? `data-old-path="${esc(f.oldPath)}"` : ''} onclick="selectFile(this)">
            <div class="direction-dot ${f.direction}"></div>
            <div class="file-path" title="${esc(f.path)}">${shortenPath(f.path)}</div>
            <span class="stat-badge">+${f.additions} -${f.deletions}</span>
        </div>
    `).join('');
}

function shortenPath(p) {
    const parts = p.split('/');
    if (parts.length <= 3) return p;
    return parts[0] + '/.../' + parts.slice(-2).join('/');
}

function esc(str) {
    const d = document.createElement('div');
    d.textContent = str;
    return d.innerHTML;
}

function renderDiff(diffText, targetEl) {
    if (typeof Diff2HtmlUI !== 'undefined') {
        new Diff2HtmlUI(targetEl, diffText, {
            drawFileList: false,
            outputFormat: 'side-by-side',
            matching: 'lines',
            highlight: true,
            renderNothingWhenEmpty: false,
        }).draw();
    } else {
        targetEl.innerHTML = `<pre class="raw-diff">${esc(diffText)}</pre>`;
    }
}

// --- File selection ---
async function selectFile(el) {
    $$('.file-item.selected').forEach(e => e.classList.remove('selected'));
    el.classList.add('selected');

    const filePath = el.dataset.path;
    const oldPath = el.dataset.oldPath;
    currentFileOldPath = oldPath || null;

    diffContent.innerHTML = '<div class="empty-state"><div class="spinner"></div> Loading diff...</div>';
    diffHeader.classList.add('hidden');

    try {
        let url = `/api/diff/${currentRepo}?oldBranch=${enc(currentOld)}&newBranch=${enc(currentNew)}&filePath=${enc(filePath)}`;
        if (oldPath) url += `&oldPath=${enc(oldPath)}`;
        const data = await api(url);
        currentFileDiff = data;

        // Header
        diffFilePath.textContent = filePath;
        if (oldPath) diffFilePath.textContent += ` (renamed from ${shortenPath(oldPath)})`;

        let meta = '';
        if (data.missedRetrofits.length) {
            const rh = data.missedRetrofits.filter(c => c.criticality === 'high').length;
            meta += `<span class="tag retrofit-tag">${data.missedRetrofits.length} missed retrofit(s)${rh ? ` (${rh} high)` : ''}</span>`;
        }
        if (data.enhancements.length) {
            const eh = data.enhancements.filter(c => c.criticality === 'high').length;
            meta += `<span class="tag enhancement-tag">${data.enhancements.length} enhancement(s)${eh ? ` (${eh} high)` : ''}</span>`;
        }
        diffMeta.innerHTML = meta;
        diffHeader.classList.remove('hidden');

        // Branch labels above diff columns
        $('#oldBranchLabel').textContent = `Old: ${currentOld}`;
        $('#newBranchLabel').textContent = `New: ${currentNew}`;
        $('#branchLabels').classList.remove('hidden');

        // Show full diff in center
        showFullDiff(data);

        // Populate right panel
        populateCommitPanel(data, filePath, oldPath);
    } catch (e) {
        diffContent.innerHTML = `<div class="empty-state">Error: ${e.message}</div>`;
    }
}

function showFullDiff(data) {
    $$('.commit-item.active').forEach(c => c.classList.remove('active'));
    clearCommitBtn.classList.add('hidden');

    if (data.diff) {
        diffContent.innerHTML = '<div id="diffView"></div>';
        renderDiff(data.diff, $('#diffView'));
    } else if (data.oldContent && data.newContent) {
        diffContent.innerHTML = '<div class="empty-state">Files are identical in both branches (code was likely cherry-picked with a different commit ID)</div>';
    } else if (data.oldContent && !data.newContent) {
        diffContent.innerHTML = `<div class="single-file-view"><div class="single-file-header deleted">File exists only in old branch (deleted in new)</div><pre class="single-file-code">${esc(data.oldContent)}</pre></div>`;
    } else if (!data.oldContent && data.newContent) {
        diffContent.innerHTML = `<div class="single-file-view"><div class="single-file-header added">File exists only in new branch (added)</div><pre class="single-file-code">${esc(data.newContent)}</pre></div>`;
    } else {
        diffContent.innerHTML = '<div class="empty-state">No content available for this file</div>';
    }
}

function critIcon(c) {
    if (c === 'high') return '<span class="crit-badge crit-high" title="High criticality">H</span>';
    if (c === 'medium') return '<span class="crit-badge crit-medium" title="Medium criticality">M</span>';
    return '<span class="crit-badge crit-low" title="Low criticality">L</span>';
}

function renderCommitList(commits, direction, pathForDiff) {
    // Sort: high first, then medium, then low
    const order = { high: 0, medium: 1, low: 2 };
    const sorted = [...commits].sort((a, b) => order[a.criticality] - order[b.criticality]);

    const hCount = sorted.filter(c => c.criticality === 'high').length;
    const mCount = sorted.filter(c => c.criticality === 'medium').length;
    const lCount = sorted.filter(c => c.criticality === 'low').length;

    let html = `<div class="crit-summary">
        <span class="crit-badge crit-high">${hCount} High</span>
        <span class="crit-badge crit-medium">${mCount} Med</span>
        <span class="crit-badge crit-low">${lCount} Low</span>
    </div>`;

    html += sorted.map(c => `
        <div class="commit-item ${direction} crit-${c.criticality}" data-hash="${esc(c.hash)}" data-path="${esc(pathForDiff)}" onclick="loadCommitDiff(this)">
            <div class="commit-top">
                ${critIcon(c.criticality)}
                <span class="commit-hash">${esc(c.hash)}</span>
            </div>
            <div class="commit-msg">${esc(c.message)}</div>
            <div class="commit-reason">${esc(c.reason)}</div>
        </div>
    `).join('');

    html += `<div class="commit-note">Commits matched by ID. Click a commit to verify its actual code impact — some may already be cherry-picked.</div>`;

    return html;
}

function populateCommitPanel(data, filePath, oldPath) {
    const rCount = data.missedRetrofits.length;
    const eCount = data.enhancements.length;

    tabRetrofitCount.textContent = rCount;
    tabEnhCount.textContent = eCount;

    if (rCount === 0 && eCount === 0) {
        commitPanel.classList.add('hidden');
        expandRight.classList.add('hidden');
        return;
    }

    commitPanel.classList.remove('hidden');
    expandRight.classList.add('hidden');

    if (rCount > 0) {
        tabRetrofits.innerHTML = renderCommitList(data.missedRetrofits, 'retrofit', oldPath || filePath);
    } else {
        tabRetrofits.innerHTML = '<div class="empty-tab">No missed retrofits for this file</div>';
    }

    if (eCount > 0) {
        tabEnhancements.innerHTML = renderCommitList(data.enhancements, 'enhancement', filePath);
    } else {
        tabEnhancements.innerHTML = '<div class="empty-tab">No enhancements for this file</div>';
    }

    if (rCount > 0) { $$('.tab')[0].click(); }
    else { $$('.tab')[1].click(); }
}

async function loadCommitDiff(el) {
    const hash = el.dataset.hash;
    const filePath = el.dataset.path;
    const isRetrofit = el.classList.contains('retrofit');

    $$('.commit-item.active').forEach(c => c.classList.remove('active'));
    el.classList.add('active');
    clearCommitBtn.classList.remove('hidden');

    diffContent.innerHTML = '<div class="empty-state"><div class="spinner"></div> Loading commit diff...</div>';

    try {
        const data = await api(`/api/commit-diff/${currentRepo}?commitHash=${enc(hash)}&filePath=${enc(filePath)}`);
        if (data.diff) {
            const label = isRetrofit ? 'MISSED RETROFIT' : 'ENHANCEMENT';
            const cls = isRetrofit ? 'retrofit' : 'enhancement';
            const critLabel = data.criticality ? ` &middot; <span class="crit-badge crit-${data.criticality}">${data.criticality.toUpperCase()}</span> ${esc(data.reason || '')}` : '';
            diffContent.innerHTML = `<div class="commit-diff-label ${cls}">${label}: commit ${esc(hash)}${critLabel}</div><div id="diffView"></div>`;
            renderDiff(data.diff, $('#diffView'));
        } else {
            diffContent.innerHTML = `<div class="cherry-picked-notice">
                <div class="cherry-picked-icon">&#x2714;</div>
                <div class="cherry-picked-text">
                    <strong>Already cherry-picked</strong><br>
                    Commit ${esc(hash)} has no code differences for this file — its changes were already applied to the other branch under a different commit ID.
                </div>
            </div>`;
        }
    } catch (e) {
        diffContent.innerHTML = `<div class="empty-state">Error: ${e.message}</div>`;
    }
}

clearCommitBtn.addEventListener('click', () => {
    if (currentFileDiff) showFullDiff(currentFileDiff);
});

// --- Event listeners ---
repoSelect.addEventListener('change', () => { loadBranches(repoSelect.value); updateCompareBtn(); });
oldBranchSelect.addEventListener('change', updateCompareBtn);
newBranchSelect.addEventListener('change', updateCompareBtn);
compareBtn.addEventListener('click', compare);
fileFilter.addEventListener('input', () => renderFileList(currentFiles));
document.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !compareBtn.disabled) compare(); });

loadRepos();
