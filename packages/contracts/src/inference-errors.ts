export class InferenceBindingDenied extends Error {
  // This error certifies rejection before a transport/Job mutation was attempted.
  constructor(
    message:
      | "Inference credential presence is unavailable"
      | "Selected inference credential is missing"
      | "Inference binding is unavailable or not reviewed for this execution" = "Inference binding is unavailable or not reviewed for this execution",
  ) {
    super(message);
  }
}
