use beet::prelude::*;

fn main() -> AppExit {
    run()
}

pub fn run() -> AppExit {
    App::new()
        .add_plugins((
            MinimalPlugins,
            LogPlugin::default(),
            ServerPlugin::default(),
        ))
        .add_systems(Startup, |mut commands: Commands| {
            commands.spawn((
                // CliServer::default(),
                HttpServer::default().with_host([0, 0, 0, 0]),
                Count::default(),
                handler_exchange(handler),
            ));
        })
        .run()
}

#[derive(Default, Component)]
struct Count(u32);

/// Handler function that processes all incoming requests.
fn handler(mut server: EntityWorldMut, request: Request) -> Response {
    // only accept `/` routes
    if !request.path().is_empty() {
        let message = format!("Not Found: {}", request.path_string());
        println!(
            "{}: {} - Not Found",
            request.method(),
            request.path_string()
        );
        return Response::from_status_body(StatusCode::NotFound, message, "text/plain");
    }

    // increment visitor count
    let name = request.get_param("name").unwrap_or("world");

    // increment visitor count
    let mut count = server.get_mut::<Count>().unwrap();
    count.0 += 1;

    let message = format!(
        r#"
hello {}
you are visitor number {}

pass the 'name' parameter to receive a warm personal greeting.
"#,
        name, count.0
    );

    println!("{}: {}", request.method(), request.path_string());
    Response::ok_body(message, "text/plain")
}
