// 让 TypeScript 识别 .md 文件的 import
declare module '*.md' {
  const content: string;
  export default content;
}
