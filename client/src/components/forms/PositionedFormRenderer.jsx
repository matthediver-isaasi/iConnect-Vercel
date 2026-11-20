import FormRenderer from './FormRenderer';
import DepartmentCurrentSetNotice from './DepartmentCurrentSetNotice';
export * from './FormRenderer';

export default function PositionedFormRenderer({ departmentPlacement, ...props }) {
  return <>
    {departmentPlacement && <DepartmentCurrentSetNotice
      state={departmentPlacement.state}
      blockedReason={departmentPlacement.blockedReason}
      placement={{ ...departmentPlacement, fieldId: props.field.id }}
    />}
    <FormRenderer {...props} />
  </>;
}
