// A single animated Champ card (local player or a friend in the session).

const PAW_DOWN_MS = 70;
const EMOJI_BUBBLE_MS = 3000;

class Champ {
    /**
     * @param {HTMLTemplateElement} template
     * @param {{isMe: boolean}} options
     */
    constructor(template, options) {
        this.root = template.content.firstElementChild.cloneNode(true);
        this.countEl = this.root.querySelector('.count');
        this.nameEl = this.root.querySelector('.name');
        this.stage = this.root.querySelector('.stage');
        this.hatEl = this.root.querySelector('.hat');
        this.bubbleEl = this.root.querySelector('.emoji-bubble');
        this.bubbleTimer = null;
        this.arms = [this.root.querySelector('.arm.left'), this.root.querySelector('.arm.right')];
        this.releaseTimers = [null, null];
        this.nextSide = 0;
        this.displayedCount = 0;
        this.isMe = options.isMe;
        this.root.classList.add(options.isMe ? 'me' : 'peer');
    }

    setName(name, statusState) {
        this.nameEl.textContent = '';
        if (statusState) {
            const dot = document.createElement('span');
            dot.className = `status-dot ${statusState}`;
            this.nameEl.appendChild(dot);
        }
        this.nameEl.appendChild(document.createTextNode(name));
    }

    /** hue 0 = original colors, 1..360 = tinted Champ. */
    setHue(hue) {
        const tint = hue > 0 ? `hsl(${hue}, 85%, 72%)` : 'transparent';
        this.root.style.setProperty('--tint', tint);
    }

    /** Shows a hat sprite (path relative to the renderer folder), or none. */
    setHat(file) {
        this.hatEl.classList.toggle('hidden', !file);
        this.hatEl.style.setProperty('--img', file ? `url("${file}")` : 'none');
    }

    /**
     * Pops an emoji bubble above the Champ for a few seconds.
     * @param {{file?: string, text?: string, label?: string}} content a Moji image or a plain emoji.
     */
    showEmoji(content) {
        this.bubbleEl.textContent = '';
        if (content.file) {
            const img = document.createElement('img');
            img.src = content.file;
            img.alt = content.label || '';
            this.bubbleEl.appendChild(img);
        } else {
            this.bubbleEl.textContent = content.text;
        }
        this.bubbleEl.classList.toggle('moji', Boolean(content.file));
        this.bubbleEl.classList.remove('hidden', 'pop');
        // Restart the CSS animation when emojis are sent back to back.
        void this.bubbleEl.offsetWidth;
        this.bubbleEl.classList.add('pop');
        clearTimeout(this.bubbleTimer);
        this.bubbleTimer = setTimeout(() => this.bubbleEl.classList.add('hidden'), EMOJI_BUBBLE_MS);
    }

    setCount(count) {
        if (count === this.displayedCount) {
            return;
        }
        this.displayedCount = count;
        this.countEl.textContent = count.toLocaleString();
        this.countEl.classList.remove('bump');
        // Restart the CSS animation.
        void this.countEl.offsetWidth;
        this.countEl.classList.add('bump');
    }

    /** Puts a paw down. side: 0 = left, 1 = right, undefined = alternate. */
    tap(side, autoRelease) {
        const index = side === undefined ? (this.nextSide = 1 - this.nextSide) : side;
        const arm = this.arms[index];
        arm.classList.remove('up');
        arm.classList.add('down');
        clearTimeout(this.releaseTimers[index]);
        if (autoRelease) {
            this.releaseTimers[index] = setTimeout(() => this.release(index), PAW_DOWN_MS);
        }
    }

    release(index) {
        const targets = index === undefined ? [0, 1] : [index];
        for (const i of targets) {
            this.arms[i].classList.remove('down');
            this.arms[i].classList.add('up');
        }
    }

    /** Replays a burst of remote taps spread over the network flush interval. */
    playBurst(taps, targetCount, durationMs) {
        const start = Math.max(0, targetCount - taps);
        const step = durationMs / Math.max(1, taps);
        for (let i = 0; i < taps; i++) {
            setTimeout(() => {
                this.tap(undefined, true);
                this.setCount(Math.max(this.displayedCount, start + i + 1));
            }, i * step);
        }
        if (taps === 0) {
            this.setCount(targetCount);
        }
    }
}

window.Champ = Champ;
