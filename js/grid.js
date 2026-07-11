// js/grid.js — slide-overview overlay (terminal-styled).
// Reuses the already-decoded preloaded Image elements, CSS-scaled into cells.

export class Grid {
  /**
   * @param {object} o
   * @param {HTMLElement} o.container  #gridOverlay
   * @param {object}      o.deck       validated deck.json object
   * @param {import('./preload.js').Preloader} o.preloader
   * @param {(index: number) => void} o.onSelect  called on cell click
   */
  constructor({ container, deck, preloader, onSelect }) {
    this.container = container;
    this.deck = deck;
    this.preloader = preloader;
    this.onSelect = onSelect;
    this.cells = [];
    this.current = 0;
    this.built = false;
  }

  build() {
    if (this.built) return;
    this.built = true;
    const inner = document.createElement('div');
    inner.className = 'grid-inner';

    this.deck.slides.forEach((slide, i) => {
      const cell = document.createElement('button');
      cell.type = 'button';
      cell.className = 'grid-cell';
      cell.setAttribute('aria-label', `Slide ${i + 1}: ${slide.title || 'untitled'}`);

      // Reuse the preloaded full image (already decoded — instant paint).
      let img = this.preloader.images[i];
      if (!img) {
        img = new Image();
        img.src = this.preloader.imageSrc(i);
      }
      img.draggable = false;
      img.alt = '';
      cell.appendChild(img);

      const label = document.createElement('span');
      label.className = 'grid-label';
      label.textContent = `${String(i + 1).padStart(2, '0')} ${slide.title || ''}`.trimEnd();
      cell.appendChild(label);

      cell.addEventListener('click', () => this.onSelect(i));
      this.cells.push(cell);
      inner.appendChild(cell);
    });

    this.container.appendChild(inner);
  }

  setCurrent(index) {
    this.current = index;
    this.cells.forEach((cell, i) => cell.classList.toggle('current', i === index));
  }

  open() {
    this.build();
    this.setCurrent(this.current);
    this.container.hidden = false;
    const cur = this.cells[this.current];
    if (cur && typeof cur.scrollIntoView === 'function') {
      cur.scrollIntoView({ block: 'nearest' });
    }
  }

  close() {
    this.container.hidden = true;
  }

  toggle() {
    if (this.isOpen) this.close();
    else this.open();
  }

  get isOpen() {
    return !this.container.hidden;
  }
}
