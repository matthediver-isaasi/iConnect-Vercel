import LoginForm from "@/components/auth/LoginForm";

export default function LoginPage() {
  return (
    <div className="bg-gradient-to-br from-blue-50 via-white to-indigo-50 flex items-start justify-center pt-12 px-4 pb-12 min-h-[60vh]">
      <div className="w-full max-w-md">
        <LoginForm />
      </div>
    </div>
  );
}
