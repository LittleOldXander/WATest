/**
 * Base class for errors that the application layer raises deliberately and
 * the presentation layer knows how to translate into an HTTP response.
 *
 * Anything that is NOT an ApplicationError is treated as unexpected by the
 * HTTP layer and mapped to a generic message, so driver internals and stack
 * traces never leak to callers.
 */
export class ApplicationError extends Error {
  public constructor(
    message: string,
    public override readonly cause?: unknown,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

/**
 * Thrown by a BannerRepository implementation when the underlying data store
 * is unreachable or returns an unexpected error.
 *
 * BannerService lets this propagate and the HTTP layer maps it to a
 * controlled `503` JSON response. This is the mechanism behind the
 * "MongoDB unavailable => 503" requirement.
 */
export class RepositoryError extends ApplicationError {}
