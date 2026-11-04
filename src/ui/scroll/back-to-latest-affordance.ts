/**
 * back-to-latest-affordance.ts — 「有新输出 · 回到最新」浮动按钮(issue #64 验收标准3)。
 *
 * 挂在滚动容器(`.shell-output-area`)内部、用 `position: sticky` 钉在其*可见
 * 视口*底部(不是 absolute——absolute 相对的是整段可滚动内容的底部,用户往上翻
 * 时会跟着上方内容一起被滚出屏幕,这是经 CDP 实测复现过的真实 bug)。
 * 天然不会盖住输入区(输入区是该容器的*兄弟*节点,不在其内),也不会盖住消息
 * 本身的可读宽度——按钮宽度随内容收缩,居中浮在滚动区域底边上方。
 *
 * sticky 要生效,本元素必须排在 DOM 流里*所有*消息子树之后(见 moveToEnd 的
 * 注释);调用方负责在每个 tab 的消息子树被创建时调用一次 moveToEnd()。
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

    /**
     * 把本元素挪到父容器(`.shell-output-area`)末尾,确保它始终排在所有
     * `.shell-tab-messages` 子树*之后*。
     *
     * 这不是摆设:`.shell-output-area` 用 `position: sticky` 把本元素钉在
     * 可见视口底部,而 sticky 的"能贴到哪"受限于它在正常流中的位置——
     * 必须有*在它之前*的、足够高的兄弟内容可以被滚过去,它才有"往下贴"的余地。
     * tab 的消息子树是惰性创建的(每个 tab 第一条消息渲染时才 createDiv),
     * 这发生在本元素构造*之后*,DOM 顺序上会被插到它后面——必须在每次
     * 出现新的子树兄弟节点时,把本元素重新挪到最后,否则它会一直停在"最前面
     * 且没有更早的兄弟"的位置,sticky 退化成和 absolute 一样跟内容一起滚走。
     */
    moveToEnd(): void {
        this.el.parentElement?.appendChild(this.el);
    }

    /** 视图卸载/会话关闭时移除 DOM。 */
    destroy(): void {
        this.el.remove();
    }
}
