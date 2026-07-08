import { TabBarItem, TabId } from './types';
import { t } from '../../i18n/zh';

export interface TabBarCallbacks {
    onTabClick: (tabId: TabId) => void;
    onTabClose: (tabId: TabId) => void;
    onNewTab: () => void;
}

export class TabBar {
    constructor(
        private readonly containerEl: HTMLElement,
        private readonly callbacks: TabBarCallbacks,
    ) {
        this.addClass(this.containerEl, 'baizer-tab-badges');
        this.containerEl.setAttribute('role', 'tablist');
    }

    update(items: TabBarItem[]): void {
        this.containerEl.empty();
        this.containerEl.setAttribute('role', 'tablist');

        for (const item of items) {
            this.renderBadge(item);
        }

        const newButton = this.containerEl.createDiv({
            cls: 'baizer-tab-badge baizer-tab-new',
            text: '+',
        });
        newButton.setAttribute('role', 'button');
        newButton.setAttribute('aria-label', t('New chat'));
        newButton.addEventListener('click', () => this.callbacks.onNewTab());
    }

    destroy(): void {
        this.containerEl.empty();
        this.removeClass(this.containerEl, 'baizer-tab-badges');
    }

    private renderBadge(item: TabBarItem): void {
        const stateClass = item.isActive
            ? 'baizer-tab-badge-active'
            : item.needsAttention
                ? 'baizer-tab-badge-attention'
                : item.isStreaming
                    ? 'baizer-tab-badge-streaming'
                    : 'baizer-tab-badge-idle';

        const badge = this.containerEl.createDiv({
            cls: `baizer-tab-badge ${stateClass}`,
            text: String(item.index),
        });
        badge.setAttribute('role', 'tab');
        badge.setAttribute('aria-selected', item.isActive ? 'true' : 'false');
        badge.setAttribute('aria-label', item.title);
        badge.setAttribute('title', item.title);
        // 漫游 tabindex:仅活跃 tab 可被 Tab 键聚焦(0),其余 -1,组内用左右方向键移动焦点。
        badge.setAttribute('tabindex', item.isActive ? '0' : '-1');
        if (item.providerId) {
            badge.setAttribute('data-provider', item.providerId);
        }

        badge.addEventListener('click', () => this.callbacks.onTabClick(item.id));
        badge.addEventListener('keydown', (event: KeyboardEvent) => this.handleBadgeKeyDown(event, item, badge));

        if (item.isActive) {
            const title = this.containerEl.createDiv({
                cls: 'baizer-tab-active-title',
                text: item.title,
            });
            title.setAttribute('role', 'button');
            title.setAttribute('aria-label', item.title);
            title.setAttribute('title', item.title);
            title.addEventListener('click', () => this.callbacks.onTabClick(item.id));
        }

        if (item.canClose) {
            badge.addEventListener('contextmenu', (event) => {
                event.preventDefault();
                this.callbacks.onTabClose(item.id);
            });
        }
    }

    private handleBadgeKeyDown(event: KeyboardEvent, item: TabBarItem, badge: HTMLElement): void {
        if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            this.callbacks.onTabClick(item.id);
            return;
        }

        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
        event.preventDefault();

        // 只在 role=tab 的徽标之间漫游(排除 "+" 新建按钮 role=button)。
        const tabs = Array.from(
            this.containerEl.querySelectorAll<HTMLElement>('.baizer-tab-badge[role="tab"]'),
        );
        const currentIndex = tabs.indexOf(badge);
        if (currentIndex === -1 || tabs.length === 0) return;

        const delta = event.key === 'ArrowRight' ? 1 : -1;
        const nextIndex = (currentIndex + delta + tabs.length) % tabs.length;
        const next = tabs[nextIndex];
        if (next) next.focus();
    }

    private addClass(el: HTMLElement, className: string): void {
        if (typeof (el as any).addClass === 'function') {
            (el as any).addClass(className);
            return;
        }
        el.classList.add(className);
    }

    private removeClass(el: HTMLElement, className: string): void {
        if (typeof (el as any).removeClass === 'function') {
            (el as any).removeClass(className);
            return;
        }
        el.classList.remove(className);
    }
}
