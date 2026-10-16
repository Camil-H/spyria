export const ErrorMessage = ({ message }: { message: string | null }) =>
  message && (
    <p role="alert" className="text-sm text-muted">
      {message}
    </p>
  )
