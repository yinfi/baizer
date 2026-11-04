/**
 * back-to-latest-affordance.ts — 「有新输出 · 回到最新」浮动按钮(issue #64 验收标准3)。
 *
 * 挂在滚动容器(`.shell-output-area`)内部、绝对定位于其底部,因此天然不会盖住
 * 输入区(输入区是该容器的*兄弟*节点,不在其内),也不会盖住消息本身的可读宽度
 * ——按钮宽度随内容收缩,居中浮在滚动区域底边上方。
 *
 * 只负责"要不要显示"与"点击时通知调用方",不持有跟随/未读状态——那些状态
 * 由 ScrollFollowController 管理,这里只是哑的 DOM 呈现层,方便独立测试。
 */

import { t } from '../../i18n/zh';

export interface BackToLatestAffordanceOptions {
    onJumpToLatest: () => void;
}

export class BackToLatestAffordance {
    private readonly el: HTMLElement;

    constructor(parent: HTMLElement, private readonly options: BackToLatestAffordanceOptions) {
        this.el = parent.createDiv({ cls: 'shell-back-to-latest baizer-hidden' });
        const button = this.el.createEl('button', {
            cls: 'shell-back-to-latest-button',
            attr: { type: 'button' },
        });
        button.createSpan({ cls: 'shell-back-to-latest-label', text: t('New messages \u00b7 Back to latest') });
        button.addEventListener('click', (event: MouseEvent) => {
            event.preventDefault();
            this.options.onJumpToLatest();
        });
    }

    /** 根据当前策略状态刷新可见性:仅「暂停跟随 且 有未读」时显示。 */
    setVisible(visible: boolean): void {
        this.el.toggleClass('baizer-hidden', !visible);
    }

    /** 视图卸载/会话关闭时移除 DOM。 */
    destroy(): void {
        this.el.remove();
    }
}
