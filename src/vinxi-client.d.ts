// vinxi@0.5.11 的发布包缺少 dist/types 产物，tsconfig 中 "types": ["vinxi/client"] 无法解析。
// 这里直接引用包内实际存在的客户端类型文件（Window.MANIFEST、ImportMeta.env）。
/// <reference path="../node_modules/vinxi/types/client.d.ts" />
