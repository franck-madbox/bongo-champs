// 18:00 podium card: top 3 of the day on their steps, confetti, and the local player's result.

const CONFETTI_COUNT = 60;
const CONFETTI_COLORS = ['#ffcc33', '#ff6fa8', '#4ab8f2', '#3ddc84', '#a46bff', '#ff9d2e'];

const api = window.bongo;
const template = document.getElementById('champ-template');

function launchConfetti() {
    const box = document.getElementById('confetti');
    for (let i = 0; i < CONFETTI_COUNT; i++) {
        const piece = document.createElement('i');
        piece.style.left = `${Math.random() * 100}%`;
        piece.style.background = CONFETTI_COLORS[i % CONFETTI_COLORS.length];
        piece.style.animationDuration = `${2.5 + Math.random() * 2.5}s`;
        piece.style.animationDelay = `${1 + Math.random() * 1.5}s`;
        box.appendChild(piece);
    }
}

function formatDay(day) {
    const [year, month, date] = day.split('-').map(Number);
    return new Date(year, month - 1, date).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
}

function render(data) {
    document.getElementById('subtitle').textContent = `${formatDay(data.day)} - ${data.total} racer${data.total === 1 ? '' : 's'}`;

    data.podium.forEach((entry, index) => {
        const place = document.querySelector(`.place[data-place="${index + 1}"]`);
        place.classList.toggle('me', entry.id === data.myId);
        const champ = new Champ(template, { isMe: false });
        champ.setHue(entry.hue);
        champ.setHat(hatFile(data.catalog, entry.hat));
        const who = document.createElement('div');
        who.className = 'who';
        who.textContent = entry.id === data.myId ? `${entry.name} (you)` : entry.name;
        const taps = document.createElement('div');
        taps.className = 'taps';
        taps.textContent = `${entry.daily.toLocaleString()} taps`;
        const step = document.createElement('div');
        step.className = 'step';
        step.textContent = String(index + 1);
        place.append(champ.root, who, taps, step);
        // Winners cheer: paws keep tapping on the podium.
        setInterval(() => champ.tap(undefined, true), 180 + index * 60);
    });

    const hours = Math.floor(data.msUntilNextRace / 3600000);
    const minutes = Math.floor((data.msUntilNextRace % 3600000) / 60000);
    const nextRace = `Next race in ${hours}h${String(minutes).padStart(2, '0')}`;
    const result = document.getElementById('result');
    if (data.reward > 0) {
        result.textContent = `You finished #${data.rank}: +${data.reward} 🎁 capsule${data.reward === 1 ? '' : 's'}! ${nextRace}.`;
        result.classList.add('reward');
    } else if (data.rank > 0) {
        result.textContent = `You finished #${data.rank} with ${data.myDaily.toLocaleString()} taps. ${nextRace}!`;
    } else {
        result.textContent = `${nextRace}. Get those paws ready!`;
    }
    launchConfetti();
}

api.on('podium', render);
