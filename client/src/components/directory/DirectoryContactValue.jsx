import { directoryContactLink } from "@/lib/directoryContactLink";

export function DirectoryContactValue({ field, value, children }) {
  const link = directoryContactLink(field, value);
  if (!link) return <>{children}</>;
  const stopPropagation = event => event.stopPropagation();
  return (
    <a
      href={link.href}
      target={link.external ? "_blank" : undefined}
      rel={link.external ? "noopener noreferrer" : undefined}
      className="text-blue-600 underline underline-offset-2 hover:text-blue-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
      onClick={stopPropagation}
      onAuxClick={stopPropagation}
      onKeyDown={stopPropagation}
      onKeyUp={stopPropagation}
    >
      {children}
    </a>
  );
}
