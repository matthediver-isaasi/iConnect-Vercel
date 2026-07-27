// Thin re-export so backend code and scripts can import the describer from
// the dashboard lib. The implementation lives in shared/ because the widget
// builder UI uses the same module for its "Suggest text" button.
export { describeWidgetConfig, default } from '../../../shared/widgetDescriber.js';
