declare module "*?raw" {
  const content: string;
  export default content;
}

declare module "*?inline" {
  const dataUrl: string;
  export default dataUrl;
}
