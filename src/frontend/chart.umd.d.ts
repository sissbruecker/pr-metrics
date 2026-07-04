/**
 * Declaration for the vendored Chart.js UMD bundle (see VENDOR.md). The bundler
 * exposes the UMD's `module.exports` as the default export; typing it as `any`
 * avoids taking Chart.js's own types on as a dependency for the one chart the
 * UI draws.
 */
declare const Chart: any;
export default Chart;
