// Bundled assets: a stylesheet applies itself; an image resolves to its published URL.
declare module "*.css";
declare module "*.png" {
  const url: string;
  export default url;
}
