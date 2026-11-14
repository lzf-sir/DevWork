/**
 * 跨端契约入口。
 *
 * 只放「写入侧」载荷定义：读侧形状由后端 *Shape 函数稳定产出，无需重复声明。
 * 新增端点时在这里加 schema，后端 routes 用 parseBody() 校验，前端直接引类型。
 */
export * from './asset';
export * from './conversation';
export * from './files';
export * from './settings';
export * from './shadow';
export * from './sql';
export * from './vocab';
export * from './workspace';
