# Hello Lightsail

An exploratory project to understand better the workflow of bootstrapping a pulumi app in regards to lightsail.


## The Plan

At `examples/server` we have a basic http server.Go ahead and run it with a timeout to see the server in action. 
The mission is to deploy this to aws lightsail in a fully reversible way via pulumi.

### Pulumi

We'll need a very basic lightsail configuration, and also an s3 bucket for storing the pulumi state. Use typescript.

lets use triples for logical naming convention: `app-name--stage--description`

config: `hello-lightsail--prod--app`
s3 bucket: `hello-lightsail--prod--state`


I'm not familiar with pulumi, but my understanding is we'll need to bootstrap the state, ie store locally while the bucket is deployed, then immediately move the state to the bucket. not sure if that happens in the typescript or justfile. 

Also I'm not sure if the reverse is also true, state must be moved locally to remove the bucket?

Document thorougly how the deployment works, including the steps of moving the app to lightsail.

Write a comprehensive `justfile` and verify `just up` and `just down` work.
