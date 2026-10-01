These certificates and the server private key are test fixtures only. They were
generated for local HTTPS connector regression tests and must never be deployed
as service credentials. The signing CA private key was discarded. Both server
certificates share the fixture key; only `server.pem` covers `127.0.0.1`.

Certificates are valid from 2020-01-01 through 2046-01-01 to avoid tying tests to
the date they were generated.
