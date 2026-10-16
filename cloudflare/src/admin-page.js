// Admin dashboard served at /admin (behind HTTP Basic auth, see checkAdmin in index.js).
// Self-contained page: it polls /admin/stats (same credentials, sent again by the browser) every 10 seconds,
// and sets the latest released app version with a JSON POST to /admin/latest-version.

export const ADMIN_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Bongo Champs Admin</title>
<style>
    :root { --bg: #1d2230; --card: #262c3d; --line: #3a4258; --text: #f2f4f8; --muted: #9aa3b5; --accent: #ff9d2e; --good: #3ddc84; }
    * { box-sizing: border-box; }
    body { margin: 0; padding: 20px 16px 40px; background: var(--bg); color: var(--text);
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
    main { max-width: 980px; margin: 0 auto; }
    header { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
    h1 { margin: 0; font-size: 22px; }
    h2 { margin: 26px 0 10px; font-size: 13px; color: var(--muted); text-transform: uppercase; letter-spacing: 1px; }
    .updated { color: var(--muted); font-size: 12px; }
    .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 10px; margin-top: 16px; }
    .card { background: var(--card); border-radius: 12px; padding: 14px 16px; }
    .label { color: var(--muted); font-size: 12px; font-weight: 700; }
    .value { font-size: 30px; font-weight: 900; margin-top: 4px; font-variant-numeric: tabular-nums; }
    .value.live { color: var(--good); }
    .sub { color: var(--muted); font-size: 12px; margin-top: 2px; }
    .two { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 10px; }
    table { width: 100%; border-collapse: collapse; background: var(--card); border-radius: 12px; overflow: hidden; }
    th, td { padding: 8px 12px; text-align: left; font-size: 13px; border-bottom: 1px solid var(--line); }
    th { color: var(--muted); font-weight: 700; }
    td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
    tr:last-child td { border-bottom: none; }
    .chart { display: flex; align-items: flex-end; gap: 3px; height: 160px; padding: 12px; background: var(--card); border-radius: 12px; overflow-x: auto; }
    .bar { flex: 1 0 14px; min-width: 14px; background: var(--accent); border-radius: 4px 4px 0 0; position: relative; }
    .bar:hover::after { content: attr(data-tip); position: absolute; bottom: 100%; left: 50%; transform: translateX(-50%);
        white-space: nowrap; background: #111; color: #fff; font-size: 11px; padding: 3px 6px; border-radius: 4px; margin-bottom: 4px; }
    .empty { color: var(--muted); font-size: 13px; padding: 12px; background: var(--card); border-radius: 12px; }
    .error { color: #ff6b6b; }
    form.release { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; padding: 12px 16px; background: var(--card); border-radius: 12px; }
    form.release input { width: 120px; padding: 7px 10px; border-radius: 8px; border: 1px solid var(--line); background: var(--bg); color: var(--text); font-size: 14px; }
    form.release button { padding: 7px 14px; border: none; border-radius: 8px; background: var(--accent); color: #1d2230; font-weight: 800; cursor: pointer; }
    form.release .sub { margin: 0; }
</style>
</head>
<body>
<main>
    <header>
        <h1>🏁 Bongo Champs Admin</h1>
        <div id="updated" class="updated">Loading...</div>
    </header>

    <div class="cards">
        <div class="card"><div class="label">Online now</div><div id="online" class="value live">-</div><div class="sub">apps connected</div></div>
        <div class="card"><div class="label">Peak today</div><div id="peak" class="value">-</div><div class="sub">simultaneous players</div></div>
        <div class="card"><div class="label">Players today</div><div id="players" class="value">-</div><div class="sub">tapped at least once</div></div>
        <div class="card"><div class="label">Taps today</div><div id="taps" class="value">-</div><div id="race" class="sub"></div></div>
    </div>

    <div class="two">
        <div>
            <h2>Top 3 today</h2>
            <table><tbody id="top"></tbody></table>
        </div>
        <div>
            <h2>App versions today</h2>
            <table><thead><tr><th>Version</th><th class="num">Players</th></tr></thead><tbody id="versions"></tbody></table>
        </div>
    </div>

    <h2>Latest app version</h2>
    <form id="release" class="release">
        <span class="label">Current: <span id="latest">-</span></span>
        <input id="latest-input" placeholder="1.4.3" pattern="\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}" autocomplete="off">
        <button type="submit">Set</button>
        <span id="release-status" class="sub">Set it after a release is published: connected apps check for the update within a minute (empty = clear).</span>
    </form>

    <h2>Taps per day (last 30 days)</h2>
    <div id="chart" class="chart"></div>

    <h2>History</h2>
    <table>
        <thead><tr><th>Day</th><th class="num">Players</th><th class="num">Taps</th><th class="num">Peak online</th></tr></thead>
        <tbody id="history"></tbody>
    </table>
</main>
<script>
    const REFRESH_MS = 10000;
    const fmt = (n) => Number(n || 0).toLocaleString();
    const $ = (id) => document.getElementById(id);

    function row(cells, numericFrom) {
        const tr = document.createElement('tr');
        cells.forEach((text, index) => {
            const td = document.createElement('td');
            td.textContent = text;
            if (index >= numericFrom) {
                td.className = 'num';
            }
            tr.appendChild(td);
        });
        return tr;
    }

    function emptyRow(body, columns, text) {
        const tr = document.createElement('tr');
        const td = document.createElement('td');
        td.colSpan = columns;
        td.textContent = text;
        td.style.color = 'var(--muted)';
        tr.appendChild(td);
        body.appendChild(tr);
    }

    function render(stats) {
        $('online').textContent = fmt(stats.now.online);
        $('peak').textContent = fmt(stats.today.peakOnline);
        $('players').textContent = fmt(stats.today.players);
        $('taps').textContent = fmt(stats.today.taps);
        const minutes = Math.floor(stats.now.msUntilEnd / 60000);
        $('race').textContent = stats.now.raceOpen
            ? 'race open, podium in ' + Math.floor(minutes / 60) + 'h' + String(minutes % 60).padStart(2, '0')
            : 'race closed (taps count until 18:00)';

        const top = $('top');
        top.textContent = '';
        stats.top.forEach((entry, index) => top.appendChild(row([['🥇', '🥈', '🥉'][index] + ' ' + entry.name, fmt(entry.daily)], 1)));
        if (!stats.top.length) {
            emptyRow(top, 2, 'No racer yet today');
        }

        const versions = $('versions');
        versions.textContent = '';
        const versionList = Object.entries(stats.today.versions).sort((a, b) => b[1] - a[1]);
        versionList.forEach(([version, count]) => versions.appendChild(row([version, fmt(count)], 1)));
        if (!versionList.length) {
            emptyRow(versions, 2, 'No data yet today');
        }

        // Today first, then archived days (most recent first).
        const days = [{ ...stats.today }, ...stats.history];
        const history = $('history');
        history.textContent = '';
        days.forEach((day, index) => history.appendChild(row([day.day + (index === 0 ? ' (today)' : ''), fmt(day.players), fmt(day.taps), fmt(day.peakOnline)], 1)));

        const chart = $('chart');
        chart.textContent = '';
        const recent = days.slice(0, 30).reverse();
        const best = Math.max(1, ...recent.map((day) => day.taps));
        recent.forEach((day) => {
            const bar = document.createElement('div');
            bar.className = 'bar';
            bar.style.height = Math.max(2, (day.taps / best) * 100) + '%';
            bar.dataset.tip = day.day + ': ' + fmt(day.taps) + ' taps, ' + fmt(day.players) + ' players';
            chart.appendChild(bar);
        });

        $('latest').textContent = stats.latestVersion || 'not set';

        $('updated').textContent = 'Updated ' + new Date().toLocaleTimeString();
        $('updated').classList.remove('error');
    }

    async function refresh() {
        try {
            // Built from the origin: a page URL carrying user:password@ would make a relative fetch fail.
            const response = await fetch(location.origin + '/admin/stats', { cache: 'no-store' });
            if (!response.ok) {
                throw new Error('HTTP ' + response.status);
            }
            render(await response.json());
        } catch (error) {
            $('updated').textContent = 'Update failed (' + error.message + '), retrying...';
            $('updated').classList.add('error');
        }
    }

    // Latest version form: JSON POST (the server refuses anything else, see index.js).
    $('release').addEventListener('submit', async (event) => {
        event.preventDefault();
        const status = $('release-status');
        try {
            const response = await fetch(location.origin + '/admin/latest-version', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ version: $('latest-input').value.trim() }),
            });
            const result = await response.json();
            if (!response.ok) {
                throw new Error(result.error || 'HTTP ' + response.status);
            }
            status.textContent = result.latestVersion ? 'Sent ' + result.latestVersion + ' to every connected app.' : 'Cleared.';
            status.classList.remove('error');
            $('latest-input').value = '';
            refresh();
        } catch (error) {
            status.textContent = 'Failed: ' + error.message;
            status.classList.add('error');
        }
    });

    refresh();
    setInterval(refresh, REFRESH_MS);
</script>
</body>
</html>
`;
