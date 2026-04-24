export class FakeElement {
  children: FakeElement[] = [];
  className = '';
  textContent = '';
  style: Record<string, any> = {};
  dataset: Record<string, string> = {};
  listeners: Record<string, Function[]> = {};
  value = '';

  createDiv(attr?: any) {
    return this.createEl('div', attr);
  }

  createSpan(attr?: any) {
    return this.createEl('span', attr);
  }

  createEl(_tag: string, attr?: any) {
    const child = new FakeElement();
    child.className = attr?.cls || '';
    child.textContent = attr?.text || '';
    this.children.push(child);
    return child;
  }

  empty() {
    this.children = [];
    this.textContent = '';
  }

  addEventListener(type: string, handler: Function) {
    if (!this.listeners[type]) this.listeners[type] = [];
    this.listeners[type].push(handler);
  }

  click() {
    for (const handler of this.listeners.click || []) {
      handler();
    }
  }

  hasClass(name: string) {
    return this.className.split(' ').includes(name);
  }

  addClass(name: string) {
    if (!this.hasClass(name)) {
      this.className = `${this.className} ${name}`.trim();
    }
  }

  removeClass(name: string) {
    this.className = this.className
      .split(' ')
      .filter(token => token && token !== name)
      .join(' ');
  }

  toggleClass(name: string, enabled: boolean) {
    if (enabled) this.addClass(name);
    else this.removeClass(name);
  }

  querySelector(selector: string): FakeElement | null {
    if (!selector.startsWith('.')) return null;
    const className = selector.slice(1);
    return this.findFirstByClass(className);
  }

  querySelectorAll(selector: string): FakeElement[] {
    if (!selector.startsWith('.')) return [];
    const className = selector.slice(1);
    return this.findAllByClass(className);
  }

  scrollIntoView(_options?: any) { }

  focus() { }

  appendChild(child: FakeElement) {
    this.children.push(child);
  }

  private findFirstByClass(className: string): FakeElement | null {
    for (const child of this.children) {
      if (child.hasClass(className)) return child;
      const nested = child.findFirstByClass(className);
      if (nested) return nested;
    }
    return null;
  }

  private findAllByClass(className: string): FakeElement[] {
    const matches: FakeElement[] = [];
    for (const child of this.children) {
      if (child.hasClass(className)) matches.push(child);
      matches.push(...child.findAllByClass(className));
    }
    return matches;
  }
}
