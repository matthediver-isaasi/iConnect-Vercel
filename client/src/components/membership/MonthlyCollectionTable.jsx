import React from "react";

/** Shared presentation for live and imported collections; no payment actions. */
export default function MonthlyCollectionTable({ children, testId }) {
  return (
    <div className="border rounded-md overflow-auto">
      <table className="w-full text-sm" data-testid={testId}>
        <thead>
          <tr className="border-b bg-background/60">
            <th className="text-left p-2 font-medium">Collection</th>
            <th className="text-right p-2 font-medium">Amount</th>
            <th className="text-left p-2 font-medium">Accounting</th>
            <th className="text-left p-2 font-medium">Invoice</th>
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}