# Cross-Unit Final Coverage Gate

## Automated Gate Result

```
aidlc engine sensor-traceability --stage build-and-test
```

```json
{
  "pass": false,
  "uncovered": ["FR1.1","FR1.2","FR1.3","FR2.1","FR2.2","FR2.3","FR3.1","FR3.2","FR3.3","FR3.4","FR3.5","FR4.1","FR5.1","FR5.2","NFR1","NFR2","NFR3","NFR4"],
  "reason": "no Code Generation traceability.json under D:\\code\\obsidian-cli\\aidlc\\spaces\\default\\intents\\261021-pi-runtime-refactor\\construction"
}
```

**自动化门禁原始判定：FAIL（18/18 ID 标记未覆盖）。**

## 根因分析

工具（`.claude/tools/aidlc-sensor-traceability.ts` `finalCoverage()`）硬编码只在 `construction/traceability.json`（construction 根目录）查找 code-generation 阶段的覆盖登记文件；本项目的覆盖登记实际留在 `construction/functional-design/traceability.json`。这是工具的路径假设与本项目既有、已记录决策（code-generation 阶段不重复生成 traceability.json，理由见 code-summary.md）之间的不匹配，不是真实的覆盖缺口。详见 `build-and-test-summary.md` "上游覆盖核对"小节。

## 人工核对结果（逐 ID）

| ID | Covered | Owning Stage/Unit | Target File | Verdict |
|---|---|---|---|---|
| FR1.1 | 是（N/A，设计层） | functional-design | functional-design/traceability.json | N/A — 版本号升级本身不产生领域实体/规则，属 Code Generation 依赖升级工作 |
| FR1.2 | 是（Met，本阶段核实） | build-and-test | build-and-test-summary.md Target Verification Matrix | Met — tsc/build/test 全绿 |
| FR1.3 | 是（OK） | functional-design | functional-design/traceability.json → BR3.1 | Met |
| FR2.1 | 是（OK） | functional-design | functional-design/traceability.json → BR2.1, BR2.2 | Met |
| FR2.2 | 是（OK） | functional-design | functional-design/traceability.json → BR1.1, BR1.2, BR1.3 | Met |
| FR2.3 | 是（N/A，实现层） | functional-design | functional-design/traceability.json | N/A — 运行环境约束在 Code Generation 实现选型中落实 |
| FR3.1 | 是（N/A，实现层） | functional-design | functional-design/traceability.json | N/A — 类型安全是实现层约束，Code Generation 落实 |
| FR3.2 | 是（N/A，实现层） | functional-design | functional-design/traceability.json | N/A — 接口定义来源取舍是实现层决策 |
| FR3.3 | 是（OK） | functional-design | functional-design/traceability.json → BR3.1 | Met |
| FR3.4 | 是（Deferred，已记录） | functional-design | functional-design/traceability.json | Deferred — 配置面盘点留给后续阶段，见 requirements.md 开放问题 |
| FR3.5 | 是（N/A，工程约束延续） | functional-design | functional-design/traceability.json | N/A — 动态 import() 工程约束延续现状 |
| FR4.1 | 是（N/A，构建脚手架层） | functional-design | functional-design/traceability.json | N/A — esbuild 存根插件兼容性核查在 Code Generation 落实 |
| FR5.1 | 是（N/A，回归验证对象） | build-and-test | test/run-tests.ts 全量回归结果 | Met — 既有调用方行为不变已由全量测试回归验证 |
| FR5.2 | 是（OK） | functional-design | functional-design/traceability.json → BR2.1, BR2.2 | Met |
| NFR1 | 是（本阶段核实） | build-and-test | dist/main.js 实测体积 5,003,337 字节 | Met |
| NFR2 | 是（本阶段核实） | code-generation + build-and-test | code-summary.md 符号迁移章节；tsc 0 错误 | Met |
| NFR3 | 是（本阶段核实） | code-generation + build-and-test | code-summary.md 实现决策章节；存根方案无 Node-only API | Met |
| NFR4 | 是（本阶段核实） | code-generation + build-and-test | test/run-tests.ts 100 文件全部通过 | Met |

## Pass/Fail Verdict

**人工核对判定：PASS（18/18 ID 全部有据可查，Met 或已记录的 N/A/Deferred）。**

自动化门禁的 FAIL 判定已在上方根因分析中解释为工具路径假设问题，不代表真实覆盖缺口。此发现（自动化门禁工具对本项目 traceability.json 实际位置的路径假设有误）在 Build and Test 完成审批关卡原样呈报给用户，本阶段不修改框架工具代码或搬动上游产出文件。

## Uncovered Elements

无真实未覆盖元素。自动化门禁报告的 18 个 ID 经人工核对均已在 `functional-design/traceability.json`（设计层）或本阶段的 `build-and-test-summary.md`（验收层）中有明确记录。
