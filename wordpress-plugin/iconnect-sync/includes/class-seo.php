<?php
if ( ! defined( 'ABSPATH' ) ) {
    exit;
}

class IConnect_Sync_SEO {

    public function __construct() {
        add_action( 'wp_head', array( $this, 'output_json_ld' ) );
    }

    public function output_json_ld() {
        if ( ! is_singular( 'iconnect_article' ) ) {
            return;
        }

        $post_id = get_the_ID();

        $title          = get_the_title( $post_id );
        $excerpt        = get_the_excerpt( $post_id );
        $author_name    = get_post_meta( $post_id, '_iconnect_author_name', true );
        $published_date = get_post_meta( $post_id, '_iconnect_published_date', true );
        $article_url    = get_post_meta( $post_id, '_iconnect_url', true );
        $image_url      = get_the_post_thumbnail_url( $post_id, 'full' );

        $schema = array(
            '@context'         => 'https://schema.org',
            '@type'            => 'Article',
            'headline'         => $title,
            'description'      => wp_strip_all_tags( $excerpt ),
            'mainEntityOfPage' => array(
                '@type' => 'WebPage',
                '@id'   => ! empty( $article_url ) ? $article_url : get_permalink( $post_id ),
            ),
        );

        if ( ! empty( $published_date ) ) {
            $schema['datePublished'] = date( 'c', strtotime( $published_date ) );
        }

        if ( ! empty( $author_name ) ) {
            $schema['author'] = array(
                '@type' => 'Person',
                'name'  => $author_name,
            );
        }

        if ( ! empty( $image_url ) ) {
            $schema['image'] = $image_url;
        }

        echo '<script type="application/ld+json">' . "\n";
        echo wp_json_encode( $schema, JSON_UNESCAPED_SLASHES | JSON_PRETTY_PRINT );
        echo "\n" . '</script>' . "\n";
    }
}
