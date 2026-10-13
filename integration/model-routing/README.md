# 可复用的路由策略与验收历史模块

这两个模块与当前工作机的实现字节一致；它们是纯函数/显式文件工具，**不是已经挂到Pi运行时的自动选模守护服务**。不会因安装本仓库自动调用模型、建立定时任务或产生费用。

- `routing-policy.mjs`：目录指纹、资格检查、够用优先分档、两轮有证据质量失败后请求评估、资源快照准入、空闲条件判断。
- `history-store.mjs`：严格键白名单的验收记录写入与统计。它不保存prompt/code，但**字符串值仍由调用方负责脱敏**；不要把“白名单字段”当作绝对无泄漏保证。
- `config/routing-policy.example.json`：默认禁用、授权provider和model池为空，供新设备自行填入。作者的真实provider映射、额度观察、模型选择与历史记录未上传。

模型目录和授权范围必须从本地真实可用目录核对。不得仅凭该模块返回candidate就发起未经授权调用；`selectModelForTask()`是排序步骤，不替代`eligibleModels()`和当前权限核对。`resourceAdmission()`明确只提供快照决策，不是跨进程原子锁。

`idleEvaluationAllowed()`计算空闲资格，不会检查外部是否允许付费，也不会自动启动后台评估；调用者应先确认配置enabled与当前用户授权。这里故意不新增自动调度器。

测试使用synthetic-provider/fast-model等假目录和临时历史，既不读取用户真实policy/history，也不外发研究材料。
