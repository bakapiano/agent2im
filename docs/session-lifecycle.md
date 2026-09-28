# 后续 Session 生命周期

当前会话接入由原 CLI 持有执行权，Broker 仅登记和投递原生队列。原生历史继续使用同一 home/thread。

用户关闭原 CLI 后，原生待处理队列留存；用户按原生流程打开会话后继续消费。session 映射通过新调用的宿主元数据重新核验。

Chat new、托管执行及 release 尚属后续产品能力。后续设计须分别明确创建者、执行权、历史写入、原生权限、释放与恢复，不改变当前按需队列接入路径。

详见[当前架构](architecture.md)与[实施计划](implementation-plan.md)。
